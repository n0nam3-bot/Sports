# NEONSLIP — Agent Cluster Betting Intelligence

A hierarchical swarm of AI agents that tears apart any sports slate (NBA / NFL / NCAAF / NCAAB / MLB / NHL)
and produces a council-approved **Top-10 slip** for the selected date. Dark, neon, gamer/capper UI.
Games that already started or finished are never analyzed — the cluster auto-skips them.

## The cluster

| Layer | Agents | Job |
|---|---|---|
| **01 Scout Division** | QUANT, MEDIC, CHRONO, MATCHUP, SHARP, PROPS | Raw intel: power lines, injuries, rest/B2B/3-in-4, scheme collisions, market value, player spots |
| **02 Analyst Desk** | STRATEGA, CONTRARIAN | Forge candidates from scout convergence — then try to kill them |
| **03 War Council** | HISTORIAN, COMMISSIONER, RISK | Lessons from graded history, final Top-10 ranking, unit sizing (12u/day cap) |

### Self-improvement loop
Every slip is graded against final scores. Rating points flow to/from every agent that stamped a bet.
An agent below a 45.5% strike rate is forced to **rewrite its own playbook prompt** (visible in the
Roster tab under *self-corrections*). Operators can also hand-tune any prompt.

## Brains — 100% free tiers

Set **any** of these; the roster spreads agents across every configured provider:

```bash
OPENROUTER_API_KEY=...   # + OPENROUTER_MODEL (default google/gemini-2.0-flash-001)
GEMINI_API_KEY=...       # + GEMINI_MODEL    (default gemini-2.0-flash)  → aistudio.google.com (free)
XAI_API_KEY=...          # + GROK_MODEL      (default grok-3-mini)
OLLAMA_BASE_URL=http://localhost:11434   # + OLLAMA_MODEL (default llama3.1) → fully local + free
```

With **zero keys** the system runs on a deterministic quantitative core (power ratings, rest
pricing, injury valuation, market-gap detection, totals model) — fully functional card, grading
and self-improvement included.

## Data — free + keyless
ESPN public JSON feeds: slates, odds (spread / ML / totals / team totals), injury reports,
scoreboards, boxscores. Rest intelligence is inferred from the previous 3 days of schedules.

## Stack
Next.js 16 · React 19 · Tailwind 4 · PostgreSQL + Drizzle · TypeScript.

```bash
npm install
npx drizzle-kit push   # create tables
npm run dev
```

## Deploy notes — access from any device

**GitHub Pages cannot run this app** (it is static-only: no Node server, no Postgres, no API routes).
Host the full app instead — every device then reaches it by URL.

### Option A — Vercel + Neon (both free, works entirely from a phone browser)
1. Push the repo to GitHub, then [vercel.com/new](https://vercel.com/new) → **Import** the repo
   (framework auto-detected: Next.js — leave all settings default).
2. Create a free Postgres at [neon.tech](https://neon.tech) → copy the **pooled connection string**.
3. Vercel → Project → Settings → Environment Variables → `DATABASE_URL` = your Neon string
   (check **Production** — and Preview if you use it). The build itself never needs it.
4. Redeploy, then open `https://your-app.vercel.app/api/setup` once — it self-creates the tables
   and seeds the roster (`{"ok":true}`). **No laptop or terminal required.**
   (First site load also auto-creates everything; `/api/setup` is just instant peace of mind.)
5. Done — open the `*.vercel.app` URL on any phone/laptop.
6. Optional: add `GEMINI_API_KEY` / `XAI_API_KEY` / `OPENROUTER_API_KEY` env vars to awaken the LLM swarm
   (without keys it runs the built-in quant core). Free-tier functions are limited to 60s, so run
   1–3 sports per card on hosted plans; heavy multi-league + LLM nights prefer a long-lived host.

### Option B — Render (free web service + free Postgres)
New Web Service → build `npm install && npm run build` → start `npm start` → add a Render Postgres
and set `DATABASE_URL`. Long-lived server: full fire-and-forget pipeline + polling works.

### Environment variables (all optional except the database)
`DATABASE_URL` (required) · `GEMINI_API_KEY` (+`GEMINI_MODEL`) · `XAI_API_KEY` (+`GROK_MODEL`) ·
`OPENROUTER_API_KEY` (+`OPENROUTER_MODEL`) · `OLLAMA_BASE_URL` (+`OLLAMA_MODEL`)

## Disclaimer
For entertainment & research. No outcome is guaranteed. Never bet what you can't afford to lose.
