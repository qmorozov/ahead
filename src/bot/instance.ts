import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { config } from "../config";

export const bot = new Bot(config.telegramBotToken);

bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
