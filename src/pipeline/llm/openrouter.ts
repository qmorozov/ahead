import axios from "axios";
import pRetry, { AbortError } from "p-retry";
import { log, logError } from "../../lib/logger";
import { errorMessage } from "../../lib/utils";
import { ChatCompletionSchema, type LLMProvider, type ModelTier, type CallOptions } from "./types";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

const MODELS: Record<ModelTier, string> = {
  light: "meta-llama/llama-3.1-8b-instruct",
  heavy: "meta-llama/llama-3.1-8b-instruct",
};

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const MIN_RETRY_MS = 2_000;
const INSUFFICIENT_CREDITS_BACKOFF_MS = 60 * 60_000;

function isRetryable(error: unknown): boolean {
  const msg = errorMessage(error);
  return (
    /429|rate/i.test(msg) || /5\d\d/.test(msg) || /ECONNRESET|ETIMEDOUT|ECONNABORTED/i.test(msg)
  );
}

function isOutOfCredits(error: unknown): boolean {
  return /402|insufficient|credits/i.test(errorMessage(error));
}

export function createOpenRouterProvider(apiKey: string): LLMProvider {
  let backoffUntil = 0;

  async function sendRequest(
    tier: ModelTier,
    systemPrompt: string,
    userContent: string,
    options?: CallOptions,
  ): Promise<string | null> {
    const { data } = await axios.post(
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
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://github.com/ahead-bot",
          "X-OpenRouter-Title": "Ahead Job Bot",
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
    );

    const parsed = ChatCompletionSchema.parse(data);
    return parsed.choices[0]?.message.content ?? null;
  }

  return {
    name: "OpenRouter",

    isAvailable: () => Date.now() >= backoffUntil,

    async call(tier, systemPrompt, userContent, options?: CallOptions) {
      try {
        return await pRetry(() => sendRequest(tier, systemPrompt, userContent, options), {
          retries: MAX_RETRIES,
          minTimeout: MIN_RETRY_MS,
          onFailedAttempt: (error) => {
            if (isOutOfCredits(error)) {
              backoffUntil = Date.now() + INSUFFICIENT_CREDITS_BACKOFF_MS;
              throw new AbortError("Insufficient credits");
            }
            if (!isRetryable(error)) throw new AbortError(`Non-retryable: ${errorMessage(error)}`);
            log(`OpenRouter retry ${error.attemptNumber}/${MAX_RETRIES}`);
          },
        });
      } catch (err) {
        if (err instanceof AbortError && err.message === "Insufficient credits") {
          log("OpenRouter out of credits, pausing for 1h");
          return null;
        }
        logError("OpenRouter", err);
        return null;
      }
    },
  };
}
