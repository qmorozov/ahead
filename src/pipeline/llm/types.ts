import { z } from "zod";

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

/** Shared schema for OpenAI-compatible chat completion responses (Cerebras, Gemini). */
export const ChatCompletionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
});
