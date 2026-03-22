export type ModelTier = "light" | "heavy";

export interface CallOptions {
  maxTokens?: number;
}

export interface LLMProvider {
  readonly name: string;
  isAvailable(): boolean;

  call(
    tier: ModelTier,
    systemPrompt: string,
    userContent: string,
    options?: CallOptions,
  ): Promise<string | null>;
}
