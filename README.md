# Ahead

Telegram bot that monitors remote job boards and sends personalized job alerts.

Aggregates from 11 sources (RemoteOK, Remotive, Jobicy, Himalayas, Arbeitnow, WeWorkRemotely, Djinni, TheMuse, WorkingNomads, RemoteFirstJobs, HN), scores each job against your profile, and sends a ranked digest.

Optionally uses Groq (Llama 8B for classification, 70B for parsing) to extract structured data from descriptions. Works without it too - falls back to keyword matching.

## Setup

Node.js 18+, bot token from [@BotFather](https://t.me/BotFather).

```bash
npm install
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN (required) and GROQ_API_KEY (optional)
npm run dev
```

Send `/start` to your bot in Telegram.

Production: `npm start`

## How it works

```
11 sources → keyword/location/salary pre-filter
  → LLM batch classification (optional)
  → LLM structured parsing (optional, cached)
  → scoring + ranking
  → dedup across sources
  → Telegram digest
```

Polling interval configurable per user (default 30 min). Each job parsed once and cached in SQLite.

## Commands

- `/start` - onboarding (role, tech stack, seniority, salary, location)
- `/settings` - edit filters, excludes, interval, pause/resume
- `/cancel` - cancel current action

## Tech

TypeScript, grammY, SQLite, Groq, Zod, node-cron.

## License

MIT
