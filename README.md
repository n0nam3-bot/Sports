# NEONSLIP — Agent Cluster Betting Intelligence

An agent cluster that prices a sports slate **against the sportsbook's own number** and releases only
the plays that still have positive expected value after the vig. UFC / DWCS / PFL get a full set of
fight markets, and a built-in **My Bets** tracker shows *your* unit gain on what you actually bet.
Dark, neon, gamer/capper UI. Games that already started or finished are never analyzed.

> **Passing is a valid result.** The cluster no longer forces a ten-pick card. If nothing clears the
> bar it says so, shows the closest calls, and lets you lower the bar (Loose) if you want more action.

## How a pick is made (engine v5)

1. **Start from the market.** The book's prices with the vig removed are the best available estimate
   of the truth. (The old engine rated teams from win-loss records and bet whenever that disagreed
   with the book — but the book knows far more than a W-L record, so big disagreements were usually
   the *model* being wrong, and bigger disagreements got bigger bets.)
2. **Nudge it, don't override it.** Rest, confirmed injuries and ESPN's own matchup projection each
   move the probability a little (heavily shrunk — the market has already priced most of it).
3. **Require confirmation.** One noisy signal is not an edge. In Standard mode two independent signals
   must agree, and the result must beat the vig at the real price (≥ 2.2% EV).
4. **Size it like a bankroll.** Quarter-Kelly on the estimated win probability and the actual price,
   rounded *down* to quarter units, haircut for how much the number is trusted. 1u = 1% of a 100u
   bankroll. Caps: 2u per posted-line bet, 1u per model-priced bet, 2u per game, and a daily limit.
5. **Limit correlation.** One side-bet per game (spread and moneyline on a side are one bet), one
   duration bet per fight, no contradictory fight picks.

**Discipline** (War Room) is the explicit volume-vs-quality dial:

| | Min EV | Max picks | Daily cap | Signals that must agree |
|---|---|---|---|---|
| Strict | 3.5% | 3 | 5u | 2 |
| **Standard** | 2.2% | 6 | 8u | 2 |
| Loose | 1.2% | 10 | 12u | 1 |

### Price provenance — book price vs model price
Every pick says where its number came from:
- **BOOK PRICE** — a posted sportsbook price (spread, moneyline, game total). EV is measured against it.
- **MODEL PRICE** — ESPN's free feed has no line for this market (most MMA markets, team totals,
  halves/quarters, player props), so the number is *ours*. These picks show our win probability, our
  fair price, and **"play it at X or better"** — your book sets the real price, so check it.
  Derived team-sport markets are **opt-in only** (pick them explicitly in Market focus).

## The cluster

| Layer | Agents | What it actually does |
|---|---|---|
| **01 Scouts** | QUANT · MEDIC · CHRONO · SHARP · PROPS | QUANT: de-vigged market + ESPN projection tilt. MEDIC: confirmed absences (leaders weigh more). CHRONO: rest/travel. SHARP: validates the odds data and price quality. PROPS: opt-in model-line markets |
| **Sport specialists** | NFL · NBA · MLB · NHL · NCAAF · NCAAB · MMA | Per-sport gates and edge bars (e.g. MLB moneylines need both starters posted); MMA runs the joint fight model |
| **02 Analysts** | STRATEGA · CONTRARIAN | Credited on converged / contrarian picks; with LLM keys they can trim or veto, within hard limits |
| **03 Council** | HISTORIAN · COMMISSIONER · RISK | Track-record gating · card assembly · fractional-Kelly unit management |

Each agent is credited **only on the picks it actually backed**, so every agent builds its own record
(the old council agents were stamped on every pick, so their ratings moved in lockstep and said nothing).

### Track-record gating (replaces "self-improvement")
The old loop asked an LLM to rewrite an agent's prompt after 8 graded bets. Eight bets is noise, the
rewrites piled up into contradictory prompt sludge, and for the deterministic scouts the rewrite
changed display text but no behaviour. Now each market bucket (e.g. `nba:spread`, `mma:fight_rounds`)
is tested against its own recent results: wins vs what the prices taken would break even at (a z-test,
v5 engine only, last 28 days). Under 20 graded bets → no judgement. Clearly cold → half stakes and a
higher bar. Very cold with 30+ bets → paused until old results age out. Prompts are versioned and
never rewritten automatically; **Reset to built-in playbook** in the Roster archives what it replaces.

## Markets

**Team sports** — *posted lines:* spreads · moneylines · game totals. *Opt-in model lines:* team totals ·
1st half / quarter / period · first-5 innings · player props. (NRFI/YRFI was removed: its Poisson model
was miscalibrated — it would have recommended YRFI on nearly every game — and there is no data to price it.)

**UFC · DWCS · PFL** — every market is derived from **one joint model** of *who wins × how it ends ×
when it ends*, so they never contradict each other:

| Market | Options |
|---|---|
| Moneyline | either fighter |
| Total rounds | over / under **0.5 · 1.5 · 2.5 · 3.5 · 4.5** (3.5 / 4.5 only on 5-round bouts) |
| Distance | **goes the distance** · **doesn't go the distance** |
| Start of round | **fight starts round 2 / 3 / 4 / 5**, yes or no |
| Point spread | a *finish handicap*: **−1.5** must win by KO/TKO/submission; **+1.5** wins unless finished |
| Winning method | a named fighter by **decision · submission · KO/TKO** |
| Significant strikes landed | over / under per fighter, with the probability at neighbouring lines |
| Takedowns landed | over / under per fighter, with the probability at neighbouring lines |

In **Market focus** you can pick any combination, down to a single line (e.g. only *Over/Under 1.5* and
*Starts Round 3*). To avoid recommending things any generic fight would satisfy, a pick must also
differ from the **division base rate**, and model-priced MMA picks never lay heavy chalk (price floor no
steeper than about −250). DWCS is separated from UFC by card name (ESPN files Contender Series under the
UFC league). If ESPN ever publishes a bout moneyline it is matched to fighters **by athlete id** and
used as a real price. Boxing is removed.

> "Point spread" has no standard definition in MMA. The finish handicap above is gradeable from the free
> feed; a round-score handicap would need judges' scorecards, which aren't available.

## My Bets — your own unit gain
Nobody places every pick, and nobody gets exactly the suggested price. On any pick (War Room or
Ledger) tap **+ I bet this**, enter the stake and odds you really got, and the **My Bets** tab shows
your record, units P/L and ROI — graded automatically when the result is in. It also shows
*your picks vs following every pick* (so you can see whether your selection adds value), a live
**EV at your price** (so a bad price is obvious), a manual-settle option for voids or different lines,
a CSV export, and a copy/restore of your workspace id so a new phone doesn't orphan your history.
Bets are private to your browser's workspace id and never appear in the shared ledger.

The Ledger's own P/L assumes *every* pick was bet at the suggested stake and price (and uses our
price floor for model-priced picks), so it is labelled as such. Use the **engine filter** there to
compare the new engine against legacy results.

## Data — free + keyless
ESPN public JSON feeds: slates, odds (spread / ML / totals), injury reports, ESPN's matchup projection,
scoreboards, boxscores, and for MMA the core API (fighter career stats, bout results, per-fight strike and
takedown statistics). Rest intelligence is inferred from the previous 3 days of schedules. Open
`/api/diag` on your deployment to check which of these your host can actually reach — including an
**MMA probe** that reports whether fighter stats, a moneyline and post-fight stats are available.

## Realistic expectations
No model sustains anything near 100%. Sportsbook prices are efficient; a very good bettor wins ~54–58% at
standard −110 juice, and break-even there is 52.4%. Win rate and profit are different things — laying −400
wins often and still loses money. Measure **units**, not win%, and use My Bets for your own record.

## Stack
Next.js 16 · React 19 · Tailwind 4 · PostgreSQL + Drizzle · TypeScript.

```bash
npm install
npm run dev
npm test              # odds math, MMA model, grading, selection, tracker, and the whole pipeline on a real SQL engine
npm run typecheck:tests
```
The schema creates and upgrades itself on first request (`ALTER TABLE … IF NOT EXISTS`), so an existing
database keeps all its history. `npx drizzle-kit push` still works if you prefer it.

**Testing against a fake ESPN:** `tests/fake-espn.ts` serves ESPN-shaped payloads, and
`NODE_OPTIONS="--import tsx --import ./tests/preload-fake-espn.ts" npm start` runs the real app against it.

## Brains — optional, and deliberately bounded

Set **any** of these; the reviewers spread across every configured provider:

```bash
OPENROUTER_API_KEY=...   # + OPENROUTER_MODEL (default google/gemini-2.0-flash-001)
GEMINI_API_KEY=...       # + GEMINI_MODEL    (default gemini-2.0-flash)  → aistudio.google.com (free)
XAI_API_KEY=...          # + GROK_MODEL      (default grok-3-mini)
OLLAMA_BASE_URL=http://localhost:11434   # + OLLAMA_MODEL (default llama3.1) → fully local + free
```

With **zero keys** the system runs on its deterministic quantitative core (de-vigged market
baseline, rest / injury / ESPN-projection adjustments, MMA joint model, fractional-Kelly sizing,
track-record gating) — a fully functional card and grading. LLM keys add a *bounded reviewer* on
top (see below); they can't invent picks or lines.

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

## Bring Your Own AI (no hardcoding, no accounts)

Visitors can plug in **their own** free API keys with the **ADD AI KEYS** button in the header:

- Keys are stored in **that visitor's browser localStorage** — they persist across refreshes and
  return visits on that device, and never need re-entering.
- They ride along on that person's requests via a single `x-neonslip-keys` header and are used
  server-side for that request only.
- They are **never written to the database, never logged, never shared** between visitors.
  Two people on the same deployment each use their own models (or none).
- **Test keys** live-fires a probe at each provider so users see green/red instantly.
- **Wipe vault** removes them from the device.

This is deliberately account-free: usernames/passwords would mean *storing other people's API keys
on your server*, which is a liability you don't want. Device-local keys give the same convenience
with none of the custody risk. Set server env vars instead if you'd rather fund the AI yourself
for everyone.

## Disclaimer
For entertainment & research. No outcome is guaranteed. Never bet what you can't afford to lose.
