# Ahead

Telegram bot that monitors remote job boards and sends personalized job alerts.

Aggregates from 12 sources (RemoteOK, Remotive, Jobicy, Himalayas, Arbeitnow, WeWorkRemotely, Djinni, TheMuse, WorkingNomads, RemoteFirstJobs, HN, Adzuna), scores each job against your profile, and sends a ranked digest.

Optionally uses Groq and Cerebras (Llama 8B for classification, 70B+ for parsing) to extract structured data from descriptions. Falls back to keyword matching when LLM is unavailable.

## Setup

Node.js 18+, bot token from [@BotFather](https://t.me/BotFather).

```bash
npm install
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN (required), GROQ_API_KEY, CEREBRAS_API_KEY, ADZUNA keys (optional)
npm run dev
```

Send `/start` to your bot in Telegram.

Production: `npm start`

## How it works

```
12 sources → keyword/location/salary pre-filter
  → LLM batch classification (optional)
  → LLM structured parsing (optional, cached)
  → scoring + ranking
  → dedup across sources
  → Telegram digest
```

Polling interval configurable per user (default 30 min). Each job parsed once and cached in SQLite. Groq is primary LLM, Cerebras kicks in as fallback when quota is exhausted.

## Commands

- `/start` - onboarding (role, tech stack, seniority, salary, location)
- `/settings` - edit filters, excludes, interval, pause/resume
- `/cancel` - cancel current action

## Tech

TypeScript, grammY, SQLite, Groq, Cerebras, Zod, node-cron.

## License

MIT