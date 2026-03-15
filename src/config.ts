import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "Missing TELEGRAM_BOT_TOKEN — create a bot via @BotFather, then add the token to .env"),
  GROQ_API_KEY: z.string().default(""),
  CEREBRAS_API_KEY: z.string().default(""),
  ADZUNA_APP_ID: z.string().default(""),
  ADZUNA_APP_KEY: z.string().default(""),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  for (const issue of parsed.error.issues) {
    console.error(`[ERROR] ${issue.message}`);
  }
  process.exit(1);
}

export const config = {
  telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
  groqApiKey: parsed.data.GROQ_API_KEY,
  cerebrasApiKey: parsed.data.CEREBRAS_API_KEY,
  adzunaAppId: parsed.data.ADZUNA_APP_ID,
  adzunaAppKey: parsed.data.ADZUNA_APP_KEY,
};

export const HTTP_TIMEOUT = 15_000;
export const CLEARBIT_TIMEOUT = 5_000;
