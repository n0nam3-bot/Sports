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

## Deploy notes
- **Full stack** (recommended): Vercel / Render / any Node host with a Postgres URL.
- **GitHub Pages** is static-only: API routes, the agent pipeline and Postgres cannot run there.
  To mirror on Pages you would host this app elsewhere and publish a static build pointing at the
  hosted API (`NEXT_PUBLIC_API_BASE`), or simply link to the hosted deployment from your Pages repo.

## Disclaimer
For entertainment & research. No outcome is guaranteed. Never bet what you can't afford to lose.
