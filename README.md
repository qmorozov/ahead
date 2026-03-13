# Ahead

Telegram bot that monitors remote job boards and sends you relevant listings on a schedule.

Pulls from RemoteOK, Remotive, Jobicy, Himalayas, Arbeitnow, and WeWorkRemotely. You configure keywords, exclude filters, and location - the bot does the rest.

With a Groq API key, job descriptions are parsed by an LLM to extract tech tags, which makes filtering much more accurate. Without it, the bot falls back to keyword matching only.

## Setup

You need Node.js 18+ and a bot token from [@BotFather](https://t.me/BotFather).

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

```bash
TELEGRAM_BOT_TOKEN=your_token    # required
GROQ_API_KEY=your_key            # optional, get one at console.groq.com
```

```bash
npm run dev
```

Send `/start` to your bot in Telegram to configure filters.

For production: `npm run build && node dist/index.js`

## How it works

```
Sources (6 APIs/RSS feeds)
  → keyword / exclude / location / age filters
  → LLM extracts tech tags (optional, cached in SQLite)
  → matches tags against user keywords
  → sends digest to Telegram
```

Each job is parsed once and cached, so the LLM isn't called again for the same posting. Polling interval is configurable per user (default 30 min).

New jobs come as a digest - a numbered list where you tap a number to see full details. On first run, only the newest job is sent to avoid flooding the chat.

## Commands

- `/start` — setup wizard (keywords, excludes, location)
- `/settings` — edit filters, change interval, pause/resume
- `/cancel` — cancel current action

## Tech

TypeScript (strict), SQLite (better-sqlite3), Groq (Llama 3.3 70B), Zod, node-telegram-bot-api, node-cron.

## License

MIT
