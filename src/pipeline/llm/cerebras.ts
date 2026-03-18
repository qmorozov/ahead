/**
 * Cerebras provider - uses raw HTTP (no official SDK).
 * Enforces a 2s minimum gap between calls to stay under their rate limit.
 * On 429, backs off for 5 minutes.
 */
import axios from "axios";
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

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
}

function isRateLimitError(error: unknown): boolean {
  return /429|rate/i.test(errorMessage(error));
}

export function createCerebrasProvider(apiKey: string): LLMProvider {
  let backoffUntil = 0;
  let lastCallAt = 0;

  async function throttle(): Promise<void> {
    const elapsed = Date.now() - lastCallAt;
    if (elapsed < MIN_CALL_GAP_MS) await sleep(MIN_CALL_GAP_MS - elapsed);
    lastCallAt = Date.now();
  }

  return {
    name: "Cerebras",

    isAvailable: () => Date.now() >= backoffUntil,

    async call(tier, systemPrompt, userContent, options?: CallOptions) {
      await throttle();

      try {
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
      } catch (err) {
        if (isRateLimitError(err)) {
          backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
          log("Cerebras rate limited, pausing for 5min");
        } else {
          logError("Cerebras", err);
        }
        return null;
      }
    },
  };
}
