# Ahead

Telegram bot that monitors remote job boards and sends personalized job alerts.

Aggregates from 15 sources (RemoteOK, Remotive, Jobicy, Himalayas, Arbeitnow, WeWorkRemotely, Djinni, TheMuse, WorkingNomads, RemoteFirstJobs, HN, Adzuna, Greenhouse, Lever, Ashby), scores each job against your profile, and sends a ranked digest.

Uses Groq, Cerebras, Gemini, and OpenRouter (Llama 3.1 8B) to extract structured data from descriptions. Providers cascade automatically — when one hits its quota, the next takes over. Free providers are tried first; OpenRouter (paid, prepaid) is the final fallback. Falls back to keyword matching when all providers are unavailable.

## Setup

Node.js 18+, bot token from [@BotFather](https://t.me/BotFather).

```bash
npm install
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN (required)
# optional: GROQ_API_KEY, CEREBRAS_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, ADZUNA_APP_ID/KEY
npm run dev
```

Send `/start` to your bot in Telegram.

Production: `npm start`

## How it works

```
15 sources → keyword/location/salary/age pre-filter
  → LLM batch classification (skip for small batches)
  → regex pre-parse (salary, location, work arrangement from full text)
  → LLM structured parsing (smart truncation, cached)
  → 14 scorers + hard reject rules
  → company enrichment (Clearbit, Djinni)
  → cross-source dedup (job key + normalized title)
  → Telegram digest or individual messages
```

Polling interval configurable per user (default 30 min, minimum 10 min). Each job parsed once and cached in SQLite. ATS jobs tracked via discovery table (first-seen date instead of unreliable publishedAt). Warmup cycles skip LLM to preserve quota. LLM cascade: Groq (free) → Cerebras (free) → Gemini (free) → OpenRouter (paid fallback).

## Commands

- `/start` - onboarding (role, tech stack, seniority, salary, location)
- `/settings` - edit filters, excludes, sources, interval, pause/resume
- `/status` - last check stats, recently skipped jobs
- `/sources` - source health dashboard
- `/delete` - delete all your data
- `/cancel` - cancel current action

## Scripts

- `npm run seed-boards` - download Greenhouse/Lever/Ashby board slugs
- `npm run build-tech-data` - regenerate tech ontology from MIND dataset
- `npx tsx scripts/score-jobs.ts` - offline scoring analysis (requires `DEBUG=1` log data)

## Tech

TypeScript, grammY, SQLite (better-sqlite3), Groq, Cerebras, Gemini, OpenRouter, Zod.

## License

MIT