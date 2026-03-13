import dotenv from "dotenv";

dotenv.config();

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) {
  console.error(
    `[ERROR] Missing TELEGRAM_BOT_TOKEN in .env\n` +
      `Create a bot via @BotFather, then add the token to .env`,
  );
  process.exit(1);
}

export const config = {
  telegramBotToken: token,
  groqApiKey: process.env["GROQ_API_KEY"] || "",
};
