import Groq from "groq-sdk";
import pThrottle from "p-throttle";
import pRetry, { AbortError } from "p-retry";
import { getLlmQuotaValue, setLlmQuotaValue } from "../../db";
import { log, logError } from "../../lib/logger";
import { errorMessage } from "../../lib/utils";
import { LLM } from "../../constants";
import type { LLMProvider, ModelTier, CallOptions } from "./types";

const MODELS: Record<ModelTier, string> = {
  light: "llama-3.1-8b-instant",
  heavy: "llama-3.3-70b-versatile",
};

const THROTTLES: Record<ModelTier, ReturnType<typeof pThrottle>> = {
  light: pThrottle({ limit: 20, interval: 60_000 }),
  heavy: pThrottle({ limit: 6, interval: 60_000 }),
};

const MAX_RETRIES = 2;
const MIN_RETRY_MS = 2_000;

function isRetryable(error: unknown): boolean {
  const msg = errorMessage(error);
  return (
    /429|rate/i.test(msg) || /5\d\d/.test(msg) || /ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg)
  );
}

function isQuotaError(error: unknown): boolean {
  return /tokens per day|tokens per hour/i.test(errorMessage(error));
}

export function createGroqProvider(apiKey: string): LLMProvider {
  const client = new Groq({ apiKey });
  let quotaExhaustedAt = parseInt(getLlmQuotaValue("quota_exhausted_at") ?? "", 10) || 0;

  function isQuotaCoolingDown(): boolean {
    return quotaExhaustedAt > 0 && Date.now() - quotaExhaustedAt < LLM.QUOTA_COOLDOWN_MS;
  }

  function markQuotaExhausted(): void {
    if (isQuotaCoolingDown()) return;
    quotaExhaustedAt = Date.now();
    setLlmQuotaValue("quota_exhausted_at", String(quotaExhaustedAt));
    log("Groq quota exhausted, pausing for 1h");
  }

  async function sendRequest(
    tier: ModelTier,
    systemPrompt: string,
    userContent: string,
    options?: CallOptions,
  ): Promise<string | null> {
    const response = await client.chat.completions.create({
      model: MODELS[tier],
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      ...(options?.maxTokens && { max_tokens: options.maxTokens }),
    });
    return response.choices[0]?.message?.content ?? null;
  }

  return {
    name: "Groq",

    isAvailable: () => !isQuotaCoolingDown(),

    async call(tier, systemPrompt, userContent, options?: CallOptions) {
      const throttled = THROTTLES[tier](() =>
        sendRequest(tier, systemPrompt, userContent, options),
      );

      try {
        return await pRetry(() => throttled(), {
          retries: MAX_RETRIES,
          minTimeout: MIN_RETRY_MS,
          onFailedAttempt: (error) => {
            if (isQuotaError(error)) throw new AbortError("Quota exhausted");
            if (!isRetryable(error)) throw new AbortError(`Non-retryable: ${errorMessage(error)}`);
            log(`Groq retry ${error.attemptNumber}/${MAX_RETRIES}`);
          },
        });
      } catch (err) {
        if (err instanceof AbortError && err.message === "Quota exhausted") {
          markQuotaExhausted();
          return null;
        }
        logError("Groq", err);
        return null;
      }
    },
  };
}
