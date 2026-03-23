import axios from "axios";
import pRetry, { AbortError } from "p-retry";
import { log, logError } from "../../lib/logger";
import { errorMessage, sleep } from "../../lib/utils";
import type { LLMProvider, ModelTier, CallOptions } from "./types";

const API_URL = "https://api.cerebras.ai/v1/chat/completions";

const MODELS: Record<ModelTier, string> = {
  light: "llama3.1-8b",
  heavy: "qwen-3-235b-a22b-instruct-2507",
};

const MIN_CALL_GAP_MS = 2_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const MIN_RETRY_MS = 2_000;

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
}

function isRateLimitError(error: unknown): boolean {
  return /429|rate/i.test(errorMessage(error));
}

function isRetryable(error: unknown): boolean {
  const msg = errorMessage(error);
  return /429|rate/i.test(msg) || /5\d\d/.test(msg) || /ECONNRESET|ETIMEDOUT|ECONNABORTED/i.test(msg);
}

export function createCerebrasProvider(apiKey: string): LLMProvider {
  let backoffUntil = 0;
  let lastCallAt = 0;

  async function throttle(): Promise<void> {
    const elapsed = Date.now() - lastCallAt;
    if (elapsed < MIN_CALL_GAP_MS) await sleep(MIN_CALL_GAP_MS - elapsed);
    lastCallAt = Date.now();
  }

  async function sendRequest(
    tier: ModelTier,
    systemPrompt: string,
    userContent: string,
    options?: CallOptions,
  ): Promise<string | null> {
    await throttle();

    const { data } = await axios.post<ChatCompletionResponse>(
      API_URL,
      {
        model: MODELS[tier],
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        ...(options?.maxTokens && { max_tokens: options.maxTokens }),
      },
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: REQUEST_TIMEOUT_MS,
      },
    );

    backoffUntil = 0;
    return data.choices[0]?.message.content ?? null;
  }

  return {
    name: "Cerebras",

    isAvailable: () => Date.now() >= backoffUntil,

    async call(tier, systemPrompt, userContent, options?: CallOptions) {
      try {
        return await pRetry(() => sendRequest(tier, systemPrompt, userContent, options), {
          retries: MAX_RETRIES,
          minTimeout: MIN_RETRY_MS,
          onFailedAttempt: (error) => {
            if (isRateLimitError(error)) {
              backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
              throw new AbortError("Rate limited");
            }
            if (!isRetryable(error)) throw new AbortError(`Non-retryable: ${errorMessage(error)}`);
            log(`Cerebras retry ${error.attemptNumber}/${MAX_RETRIES}`);
          },
        });
      } catch (err) {
        if (err instanceof AbortError && err.message === "Rate limited") {
          log("Cerebras rate limited, pausing for 5min");
          return null;
        }
        logError("Cerebras", err);
        return null;
      }
    },
  };
}
