export type ModelTier = "light" | "heavy";

export interface CallOptions {
  maxTokens?: number;
}

/**
 * A pluggable LLM provider (Groq, Cerebras, etc.).
 *
 * Each provider manages its own health - rate limits, quotas, backoff timers.
 * The orchestrator just asks "are you up?" and tries the next one if not.
 */
export interface LLMProvider {
  readonly name: string;
  isAvailable(): boolean;

  /**
   * Returns the response string on success, null if the provider can't handle
   * the request right now (rate-limited, quota hit). The provider is responsible
   * for updating its own health state before returning null.
   */
  call(
    tier: ModelTier,
    systemPrompt: string,
    userContent: string,
    options?: CallOptions,
  ): Promise<string | null>;
}
