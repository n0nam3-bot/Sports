# NEONSLIP — HANDOFF

> **The source of truth for any new chat or contributor. Read this whole file before proposing or changing anything.**
> If this file and the code ever disagree, **the code wins** — then fix this file.

| | |
|---|---|
| **Project** | NEONSLIP — an agent-cluster sports-betting intelligence app (Next.js 16 · React 19 · Tailwind 4 · PostgreSQL + Drizzle · TypeScript) |
| **Repo** | https://github.com/n0nam3-bot/Sports (public, single branch `main`) |
| **Release** | v5.2.0 "Market-Anchored Engine" (`src/lib/release.ts`, built 2026-11-24) · engine v5 · playbook v5 |
| **Handoff written / last updated** | 2026-11-23 / 2026-11-24 |
| **Base commit** | `041948d` (2026-11-24 05:53 ET) — HEAD when v5.2.0 was built. It only added this file and the README banner; the last commit that changed *code* is `ba40a22` (2026-11-11). The v5.2.0 changes are the §22 entry dated 2026-11-24: they reach git when the owner uploads that zip |
| **Health at v5.2.0** | tests **160 / 160 pass** (~65 s) · `tsc` clean (app and tests) · `next build` OK · lint **4 errors + 1 warning**, unchanged (K-04) · the new Ledger/Log screens were also rendered from a real `/api/runs` payload in a simulated DOM (§15) — **not** seen in a browser |
| **Verified with** | Node 22.23.5 / npm 10.9.9 (`package.json` has no `engines` pin). Fake ESPN only — **live ESPN and the live deployment were not reachable** from the verification sandbox |

**Staleness check — do this first.** Run `git log --stat <base commit>..HEAD`. The commits after the base should match the newest entries in §22 (the owner's uploads of earlier zips; ignore commits that only touch `HANDOFF.md` / `README.md`). Anything else is **unrecorded work**: read it and update this file *before* relying on it. Also ask the owner whether the last zip delivered (by you or an earlier chat) has been uploaded — if not, have them attach it, otherwise you build on stale code and your whole-file delivery can overwrite theirs.

---

## Kickoff text — save it in your Project / account instructions, or paste it at the start of a chat

```text
At the start of every chat about NEONSLIP: run `git clone https://github.com/n0nam3-bot/Sports.git`
in the sandbox and read `HANDOFF.md` fully before doing anything else. It is the single source of
truth. Ask me whether the last zip you gave me has been uploaded; if not, have me attach it.
Every time you give me code, run the checks listed in HANDOFF.md and put the changed files plus
an updated `HANDOFF.md` (current state, known issues, roadmap, changelog) in the same zip.
If the clone fails, ask me to attach or paste the file.
```

*Scope:* in a Project used only for NEONSLIP the wording above is right. In account-wide instructions it would fire in unrelated chats, so start it with "When I mention NEONSLIP:" instead. The clone needs the chat's code-execution / file-creation capability switched on.

*No repo access in that chat?* Ask the owner to attach or paste this file plus the specific files involved — never guess at code you cannot see.

---

## Contents

0. [The 10 rules](#0-the-10-rules)
1. [Session protocol](#1-session-protocol)
2. [Owner & context — what is and isn't known](#2-owner--context--what-is-and-isnt-known)
3. [What the product does](#3-what-the-product-does)
4. [Architecture at a glance](#4-architecture-at-a-glance)
5. [The engine (v5): how a pick is made](#5-the-engine-v5-how-a-pick-is-made)
6. [Selection, staking and leans](#6-selection-staking-and-leans)
7. [Track-record gating, agents and ratings](#7-track-record-gating-agents-and-ratings)
8. [MMA (UFC / DWCS / PFL)](#8-mma-ufc--dwcs--pfl)
9. [Re-runs: the ledger-aware behaviour (latest feature)](#9-re-runs-the-ledger-aware-behaviour-latest-feature)
10. [Grading](#10-grading)
11. [Data model](#11-data-model)
12. [API surface](#12-api-surface)
13. [Identity, privacy and security model](#13-identity-privacy-and-security-model)
14. [Frontend map and conventions](#14-frontend-map-and-conventions)
15. [Testing](#15-testing)
16. [Deploy and operations](#16-deploy-and-operations)
17. [Where we left off](#17-where-we-left-off)
18. [Known issues and tech debt](#18-known-issues-and-tech-debt)
19. [Roadmap](#19-roadmap)
20. [Removed on purpose — do not re-add](#20-removed-on-purpose--do-not-re-add)
21. [Glossary](#21-glossary)
22. [Changelog and project history](#22-changelog-and-project-history)

---

## 0. The 10 rules

These are the rules that, if broken, cause real damage. Everything else in this file is detail.

1. **Read first, verify second.** Read this file, then confirm what you rely on against the code. Code wins; then fix the doc.
2. **Passing is a valid result.** Never force picks, pad a card, or lower a bar silently. Any change that makes the engine release *more* picks needs the owner's explicit OK and a changelog entry.
3. **Deliver one zip of complete files, never patch scripts.** The owner uploads through the GitHub web UI (every one of the 371 commits is "Add files via upload"). Put every changed file **in full**, at its **full repo path** (e.g. `src/lib/engine.ts`), in **one zip together with the current `HANDOFF.md`**; list the changed files in your message and keep that set small. Never write `patch_*.py` / `fix_*.py`-style scripts: 23 stale ones sit in the repo root today (K-02) and several would damage the current code if run.
4. **Verify before delivering.** In a sandbox run the checks in §1. "Tests pass" must mean *you ran them*. If you could not run something, say so plainly. Don't add new lint errors (4 pre-existing).
5. **The schema lives in two places.** `src/db/schema.ts` (Drizzle) **and** `src/lib/schema.ts` (`ensureSchema()`, raw idempotent SQL). Change both, additively only (`ADD COLUMN IF NOT EXISTS`), and cover it in `tests/schema-upgrade.test.ts`. The owner runs no migrations — the app upgrades the database itself on first request.
6. **Secrets and identity.** LLM keys travel only in the `x-neonslip-keys` header for one request — never store or log them. Never serialise `ownerId` (a workspace id is a credential): use `scrub()`. Never expose server env keys.
7. **A lean is `units === 0`.** That zero is how every screen and query recognises a lean. A play must never have 0 units; a lean must never have more. Leans never touch the record, P/L, agent ratings or track-record gating.
8. **One wager = one ledger row.** Identity is `dedupeKey` (§11). Never insert a clone; never count a wager twice in any record.
9. **Don't casually bump `PROMPT_VERSION`** (`src/lib/agents.ts`) — it archives and **resets every agent's rating and W-L record**. Bump `ENGINE_VERSION` only for a deliberate new engine (health gating reads `engine_version >= 5`).
10. **Update this file with every delivery** — a chat's end is invisible to you, so don't wait for it. Refresh §17 Where we left off, §18 Known issues, §19 Roadmap and add a §22 Changelog entry, and put the **complete** file (not a diff) in the same zip as the code.

---

## 1. Session protocol

### Start of session
1. **Get the code.** `git clone https://github.com/n0nam3-bot/Sports.git` works without credentials. (In one session `web_fetch` on the `.git` URL was refused — clone with git, or browse `https://github.com/n0nam3-bot/Sports` / raw.githubusercontent.com.) If you can't clone (no sandbox or no network), ask the owner to attach or paste this file and the files you need.
2. **Read this file**, run the staleness check above, and ask whether the last zip has been uploaded.
3. **Run the health checks** and compare with the Health row in the header:

   ```bash
   npm install
   npm test                  # 160 tests, ~65 s — in-memory Postgres (PGlite) + a fake ESPN
   npm run typecheck         # app only
   npm run typecheck:tests   # app + tests
   npx next build            # needs no DATABASE_URL
   npx eslint .              # known: 4 errors + 1 warning (K-04)
   ```
4. **If the owner opened with a clear task, do it** (after steps 1–3) and flag anything in §17 / §18 that affects it. **If not, brief them in ≤ 5 lines** — current state · what was last in progress (§17) · your top 3 proposals — and ask for direction before changing anything.
5. **Ask the open questions in §2** if the task depends on them.

### While working
- Small, focused changes. Prefer editing existing files over adding new ones.
- Every behaviour change gets a test. Touching selection, grading, dedupe or schema? Write the test first.
- Keep pure logic in `src/lib/*` (unit-testable); keep route handlers thin.
- Don't "improve" things that weren't asked for. Put ideas in §19 instead.

### Handing code back
- Deliver **one zip**: the changed files, complete, at their repo paths, **plus the updated `HANDOFF.md` — every time**. List the changed files in your message.
- Tell the owner how to ship it: **unzip first**, then *GitHub → Add file → Upload files* → drag the extracted files/folders in (folder paths are preserved) → *Commit changes*. Folders can also be created by typing a path when creating a file. **Don't upload the `.zip` itself**: GitHub stores it as a file — on 2026-11-11 a `Sports-main-wip.zip` (and a stray file called `download`) landed in the repo and were deleted within minutes.
- **Bump `src/lib/release.ts`** (`version`, `name`, `built`, `features`) with every code delivery: after the host redeploys, `/api/version` then proves the upload landed in full (the owner has no CI and no terminal to check otherwise).
- Tell the owner what to look at after deploy: `/api/version`, `/api/health`, and the specific screen you changed.

### Every delivery (not just "the end")
Refresh §17 (where we left off), §18 (known issues), §19 (roadmap), add a §22 entry, update the header's *Base commit / Health* rows if you re-verified, and put the **complete** `HANDOFF.md` in the zip. If a session produced no code but changed what is known (a decision, a new issue), still hand over the updated file.


---

## 2. Owner & context — what is and isn't known

**Established from git history (facts):**
- Single owner. 371 commits, 2026-09-26 → 2026-11-11, essentially all titled "Add files via upload". Folders were made in the GitHub web UI with placeholder files named `A` (commits "Create A", "Rename src/app/api/bets/A to tests/A", "Delete tests/A"). **Assume no local terminal and often a phone** unless told otherwise (the README stresses "no laptop or terminal required"). Give click-by-click instructions, not shell snippets, for anything the owner must do themselves. Chats deliver code as a **zip**; the owner unzips and uploads the files (a `.zip` once reached the repo by mistake, see §1).
- The deploy target described in the README is **Vercel + Neon** (Render is the documented alternative). The repo records no live URL.
- The product tone is a dark, neon "gamer/capper" UI. Keep new UI in that language (§14).

**Not recorded anywhere — ask the owner when it matters:**

| Question | Why it matters |
|---|---|
| Live URL and host (Vercel or Render?) | Function time limits (§16) and how `/api/runs` executes |
| Is `ADMIN_OWNER_ID` set, and to which workspace id? | Unlocks prompt edit / reset in the Roster tab (§13) |
| Are any server-side LLM keys set (`GEMINI_API_KEY` etc.)? | If so, *any* visitor's run spends that quota (K-09) |
| Is the site private or shared with other people? | Decides how much K-09 (unauthenticated endpoints) matters |
| Which roadmap items matter most? | §19 is reconstructed from the repo — priorities are the owner's call |
| Do they have a terminal/laptop? | Cleanup tasks like K-02 are one `git rm` with a terminal, many clicks without |

---
## 3. What the product does

NEONSLIP prices a sports slate **against the sportsbook's own number** and releases only the plays that still have positive expected value after the vig. It covers NBA · NFL · NCAAF · NCAAB · MLB · NHL (spread / moneyline / total, plus opt-in derived markets) and **UFC · DWCS · PFL** (a full set of fight markets from one joint model). A built-in **My Bets** tracker shows the *owner's own* unit gain on what they actually bet. Games that already started or finished are never analysed.

Design stance (do not erode it):
- **The market is the prior.** The old engine rated teams from W-L records and bet whenever it disagreed with the book; big disagreements were usually the *model* being wrong. v5 starts from the de-vigged book probability and only *nudges* it.
- **A pass is a deliverable.** If nothing clears the bar, the run says so, shows the funnel (games → priced → candidates → plays + leans), lists the closest calls, and offers "lower the bar".
- **LLMs are bounded reviewers, never pickers.** With zero keys the system runs fully on its deterministic core.
- **Honest labels.** Every pick states whether its price is a **BOOK PRICE** (posted sportsbook number) or a **MODEL PRICE** (ESPN has no line; the number is ours — "play it at X or better").

---

## 4. Architecture at a glance

**Stack:** Next.js 16 (App Router, Turbopack) · React 19 · Tailwind 4 · PostgreSQL via `pg` + Drizzle ORM · TypeScript (strict) · `tsx --test` (Node test runner) · PGlite for tests. Data: ESPN public JSON (keyless). Optional LLMs: OpenRouter, Gemini, xAI Grok, Ollama.

### Directory map
```text
src/app/
  layout.tsx, page.tsx, globals.css   single page; page renders <AppShell/>
  api/slate/            GET   game board for date + sports (75 s in-memory cache)
  api/runs/             GET   run list (Ledger + Log windows)    POST  launch the pipeline
  api/runs/[id]/        GET   one run + its picks (UI polls this while a run is "running")
  api/runs/public/      legacy public feed — UI no longer calls GET (K-08)
  api/grade/            POST  settle pending picks + agent ratings
  api/agents/           GET roster · PATCH edit prompt (admin) · POST reset to built-in playbook (admin)
  api/bets/             GET/POST/PATCH/DELETE personal tracker (needs a workspace id) · GET ?format=csv
  api/keys/test/        POST  probe the visitor's own LLM keys
  api/setup/            GET/POST  create tables + seed roster
  api/diag/ version/ health/        self-tests (§16)
src/components/
  app-shell.tsx         tabs, all top-level state, launch + poll + grade flows
  war-room.tsx          control deck, kernel console, "the slip", leans, funnel, slate board
  runs-view.tsx         the "Prediction Ledger" tab (Ledger | Log toggle)
  ledger.ts             Ledger-vs-Log rules (pure, tested): runKind · isLogRun · splitRuns · ledgerCount
  agents-view.tsx       the "Agent Roster" tab (+ admin buttons)
  my-bets-view.tsx · bet-control.tsx    personal tracker UI
  keys-modal.tsx · keys.ts              BYO-AI key vault, workspace id, fetch wrappers
  types.ts              client-side mirror of the API types (kept schema-import-free)
  ui.tsx                shared bits (Panel, Chip, bars, buttons)
src/db/        schema.ts (Drizzle tables + JSON types) · index.ts (lazy pool proxy)
src/lib/
  engine.ts        orchestration: slate → candidates → review → select → persist; grading
  espn.ts          ESPN site-API client + parsers (slate, odds, injuries, rest, finals, player stats)
  fighter-stats.ts ESPN core API: fighter profiles, bout moneylines, post-fight stats
  team-model.ts    market-anchored team-sport pricing (+ per-sport PARAMS)
  mma-model.ts     joint MMA model (winner × method × round) and market-probability functions
  mma-picks.ts     MMA candidate generation (probability floors, base-rate deviation, price floor)
  combat.ts        small helper (fighterStrength) still imported by mma-model
  markets.ts       market catalogue + the user's "Market focus" filter
  candidate.ts     Candidate type, clusterFor(), bucketOf(), formatting
  selection.ts     council: gates, Kelly sizing, caps, leans, near-misses
  discipline.ts    Strict / Standard / Loose configuration
  edge.ts          pure pricing math: de-vig, EV, Kelly, normal cdf, stake rounding
  health.ts        track-record gating (z-test per market bucket)
  review.ts        bounded LLM-review rules
  llm.ts           provider router + the x-neonslip-keys header
  agents.ts        roster definitions, seeding/upgrade, Elo-style ratings, playbook reset
  grading.ts       pure settlement of team + MMA bets
  bets.ts          personal-tracker logic
  schema.ts        ensureSchema(): idempotent DDL bootstrap
  owner.ts · scrub.ts · release.ts
tests/             14 test files, 160 tests, fake ESPN, helpers (§15)
```

### Data flow of one run
```text
War Room ── POST /api/runs {date, sports, markets, includeEvents, discipline} ──▶ insert runs row (status "running")
     │     Vercel / Lambda: pipeline runs inline inside the request (maxDuration 60 s)
     │     other hosts (Render, local): fire-and-forget; UI polls GET /api/runs/:id every 1.3 s
     ▼
runPipeline(runId, keys, ownerId, llmEnabled)                           src/lib/engine.ts
  1  cachedSlate()        ESPN scoreboard + odds; per-game summary (injuries, ESPN projection);
                          rest/B2B from the previous 3 days' schedules; MMA enrichment (fighter stats, bout moneyline)
  2  scouts               evaluateTeamGame() / evaluateBout() → Candidate[]  (every bettable side, with
                          modelProb, price, EV, agree, trust, cluster, bucket)
  3  HISTORIAN            loadHealth() → per-bucket stake multiplier / EV bump (+ global bump)
  4  ledger check         load picks already on the ledger for slateDate + sports → pool = candidates that are
                          not duplicates and whose angle (cluster) is not already taken            (§9)
  5  LLM review (opt.)    shortlist ≤ 18, bounded vetoes/trims                                     (§7)
  6  council              selectCard(pool + ledger seed) → card + leans;  selectCard(all) → "standing" picks
  7  finishRun()          insert predictions (leans get units 0) → runs.council = headline, memo, funnel, repeats
Grading is separate: POST /api/grade → gradePending() → settle → agent ratings                      (§10)
```
Time guards: slate loader budget 16 s / 60 injury lookups inside a run (12 s / 30 for the board); LLM review is skipped if the run is already > 32 s old; review budget 20 s; slate cache TTL 75 s (per server instance).

---

## 5. The engine (v5): how a pick is made

**Team sports** — `src/lib/team-model.ts`:
1. **Market view** (`marketView`): de-vig each two-way market (proportional method). A market whose implied total is outside 100–115 % is junk → the game is passed. Spread and moneyline must agree on the favourite (skipped for near coin-flips). NHL/MLB ±1.5 lines are cross-checked against the same team's moneyline (a swapped price would manufacture a fake edge), and a ±1.5 line with a missing price is skipped — **never defaulted to −110**.
2. **Gates** (`readGame`): no posted lines, suspect data, or **injury report not fetched** → the game is passed ("no injuries listed" ≠ "we never looked").
3. **Nudges** (margin units, positive favours home), each heavily shrunk because the market already priced most of it:

   | Signal | Agent | Shrink | Notes |
   |---|---|---|---|
   | ESPN matchup projection (BPI/FPI) | QUANT | 0.20 | capped at ±0.15 σ |
   | Confirmed injuries | MEDIC | 0.25 | Out = 1.0, Doubtful = 0.7, Questionable = 0.3; a team leader counts fully, a bench name 0.45; weight capped at 3 |
   | Rest / back-to-back / 3-in-4 / travel | CHRONO | 0.35 | per-sport penalty |

   The nudged probability is `shiftProb(marketP, dm, σ)` (a shift on the normal quantile scale).
4. **Per-sport parameters** (`PARAMS`):

   | Sport | σ margin | σ total | pts per rotation player out | B2B penalty | extra EV demanded |
   |---|---|---|---|---|---|
   | NBA | 12.0 | 17.5 | 1.5 | 1.8 | 0 |
   | NFL | 13.2 | 10.5 | 2.1 | 2.0 | 0 |
   | NCAAB | 10.5 | 15.0 | 1.4 | 1.5 | +1.0 pt |
   | NCAAF | 15.5 | 13.5 | 2.1 | 1.8 | +1.0 pt |
   | NHL | 2.3 | 2.3 | 0.22 | 0.28 | +1.0 pt |
   | MLB | 4.3 | 4.2 | 0.28 | 0.18 | +0.5 pt |

5. **Candidates**: for each market the better-EV side is built (spread, moneyline, total; opt-in derived markets). Moneylines never lay steeper than **−350** (`MAX_CHALK`); **MLB moneylines need both probable starters posted**. `agree` = how many of QUANT / MEDIC / CHRONO point the same way as the pick, each by at least 3 % of σ. SHARP (vig on that side ≤ 2 pts) and the sport "expert" are credited in `signals` but do **not** count toward `agree`. `rank = EV×100 + 10×(pWin − 0.5)`.
6. **Derived markets** (team totals, halves, quarters, F5, player props) have no posted line in the free feed → **model-priced, opt-in only** (pick them in *Market focus*), trust 0.5, +1 pt EV bar, probability ≥ 0.57 required. Player props use the *median*, not the mean.

**Market focus** (`src/lib/markets.ts`): `buildFilter(selected)`. Empty/unrecognised selection = **"mixed"** = spread / moneyline / total + all MMA categories. An unrecognised selection must never silently block every pick.

**Dates** are `YYYY-MM-DD` in **America/New_York**. Odds are American. **1 unit = 1 % of a 100-unit bankroll.**

---

## 6. Selection, staking and leans

`selectCard()` in `src/lib/selection.ts`, configured by `src/lib/discipline.ts`.

| Discipline | Min EV | Max picks | Daily cap | Signals that must agree | Max leans |
|---|---|---|---|---|---|
| Strict | 3.5 % | 3 | 5u | 2 | 3 |
| **Standard** (default) | 2.2 % | 6 | 8u | 2 | 5 |
| Loose | 1.2 % | 10 | 12u | 1 | 6 |

**Effective EV bar** for a posted-price candidate:
`minEv + PARAMS[sport].evBump + bucketHealth.evBump + globalBump (+1 pt if it is a model-priced non-MMA "derived" market)`.
So on Standard: NBA/NFL 2.2 %, MLB 2.7 %, NHL/NCAAB/NCAAF 3.2 %. Book-priced picks also need `agree ≥ minAgree`.

**Staking** (`edge.ts → stakeUnits`): `floor₀.₂₅( 100 × 0.25 × KellyFraction(pWin, price, pPush) × trust × bucketStakeMult )`, then **0 if below 0.25u**, else capped at **2u (book) / 1u (model-priced)**. `trust`: book 1.0 · derived 0.5 · MMA model-priced 0.4 · MMA with a real ESPN moneyline 0.7. Rounding is always *down*.

**Caps and correlation limits**: 2u per game; one bet per *cluster* per game (spread + moneyline on a side are one bet; the three MMA duration markets are one bet; sig-strikes and takedowns are per fighter); per-game pick limit 2 in mixed mode / 3 when markets were chosen; contradictory fight picks are blocked (`contradicts()`); daily cap per discipline.

**MMA model-priced picks** skip the EV test (no price to test against): their probability floors and base-rate deviation were applied at generation (§8); `strict` additionally needs fighter stats to confirm.

**Leans** — a candidate with a *small positive* edge (`EV ≥ 0.4 %`, `modelProb ≥ 0.5`, posted price only) that was held back only because its EV fell under the bar, it lacked enough confirming signals, its stake would round below 0.25u ("too thin"), the card was full, or the daily risk cap was reached (`LEAN_REASONS`); never a vetoed pick, never a model-priced one. Published with **no suggested stake** (`units = 0`), graded separately, excluded from record / P/L / ratings / health. Purpose: let the owner see with data whether the bar is set too high.

**The funnel** (`council.funnel`): games → analysed → priced → candidates → plays + leans (+ `repeats`), the best EV on the board vs the bar, and a list of games that couldn't be priced and why. It exists so "why so few picks?" is answerable at a glance.

**Near-misses** (`nearMisses`) list substantive rejections first; redundancy rejections ("a better pick already covers this angle") only fill leftover space.

---

## 7. Track-record gating, agents and ratings

**Gating** (`src/lib/health.ts`) replaced the old "LLM rewrites an agent's prompt after 8 bets" loop (8 bets is noise; the rewrites piled up into contradictory prompts; for deterministic scouts they changed nothing). Per market bucket (`sport:category`; UFC/DWCS/PFL share `mma:`), using only **v5 engine**, **staked** (`units > 0`), graded win/loss picks from the last **28 days** (max 800 rows): a z-test of wins vs the sum of break-even probabilities at the prices taken.

| Condition | Status | Effect |
|---|---|---|
| < 20 graded bets | new | no judgement |
| z ≤ −1.3 | cold | half stakes, +1.5 pt EV bar |
| z ≤ −2.0 **and** ≥ 30 bets | frozen | paused (stake ×0, +3 pt) until old results age out |
| whole engine: ≥ 40 bets and z ≤ −1.5 | global bump | +1 pt on every bar |

**LLM review** (`src/lib/review.ts`): reviewers see numbered candidates only. They can **veto** (concrete reason ≥ 12 chars; at most 40 % of the shortlist per run), **trim** a probability by up to 5 pts (total ≤ 6), or **boost** by up to 2. They cannot add picks, lines or prices. Unparseable / unreachable models change nothing — the deterministic card stands. Providers are spread across whatever is configured (stable hash of agent id).

**Agents** (`src/lib/agents.ts`, 17 of them): scouts QUANT · MEDIC · CHRONO · SHARP · PROPS; sport reviewers NFL/NBA/MLB/NHL/MMA/NCAAF/NCAAB `_EXPERT`; analysts STRATEGA · CONTRARIAN; council HISTORIAN · COMMISSIONER · RISK. An agent is credited **only on picks it backed** (`stampAgents`): scouts via `signals`; COMMISSIONER on every pick; STRATEGA when `agree ≥ 2`; CONTRARIAN on plus-money/underdog picks; RISK when the stake sits at its per-bet cap or the bucket is cold (stake multiplier < 1); HISTORIAN when the bucket has ≥ 20 graded bets.

**Ratings**: Elo-style, expectation = the pick's own `modelProb` (clamped 0.30–0.85), step `K(28) × (result − expected) × 0.28`, rating clamped 1290–1780, tiers ON TRIAL → ROOKIE → JOURNEYMAN → PRO → ELITE SHARP → GRANDMASTER. Settled against the **HOUSE** roster only. Leans never move ratings.

**Playbooks**: `PROMPT_VERSION` (currently 5) — outdated rows are upgraded automatically and **their record is archived then reset**. Owner-only (`ADMIN_OWNER_ID`) actions: *hand-tune prompt* (PATCH) and *reset to built-in playbook* (POST, archives what it replaces). There is no automatic prompt rewriting any more (§20). Per-owner rosters are vestigial: the pipeline, ratings and admin edits only use `HOUSE` (K-11).

---

## 8. MMA (UFC / DWCS / PFL)

- One **joint model** (`mma-model.ts`): *who wins × how it ends × when it ends*, so every market agrees with every other. Inputs: records, weight class, scheduled rounds, promotion, and — when ESPN's core API answers — career fighter stats (strike rate/accuracy/defence, takedowns, finish %, reach, stance).
- Markets: moneyline · total rounds 0.5–4.5 (3.5/4.5 only on 5-rounders) · goes / doesn't go the distance · fight starts round 2–5 · "point spread" = *finish handicap* (−1.5 must win by KO/TKO/sub; +1.5 wins unless finished) · method of victory (decision / sub / KO-TKO) · significant strikes and takedowns over/under per fighter.
- ESPN publishes **no sportsbook price** for almost all of these, so most MMA picks are **model-priced**: our probability, our fair price, and a **price floor** ("play it at X or better"; cushion 3.5 pts). `MMA_TRUST` 0.4. If ESPN does publish a bout moneyline it is matched **by athlete id, never by position** and used as a real price (trust 0.7).
- Generation floors (`mma-picks.ts`): ml/rounds/distance ≥ 0.62, start-round ≥ 0.66, spread/sigstr/td ≥ 0.58, method ≥ 0.40, each moved by the discipline's `probShift` (Strict +4 pts, Standard 0, Loose −3 pts); **ceiling 0.75** (never lay heavy chalk on an invented number — price floor no steeper than ≈ −250); a pick must differ from the **division base rate** by ≥ the discipline's `minDeviation` (Strict 6 pts, Standard 4, Loose 3). If fighter stats don't load, MMA falls back to records only (stricter bar, no strikes/takedown/method/spread picks).
- **DWCS** is separated from UFC by card name (ESPN files Contender Series under its `ufc` league). Boxing was removed.
- `/api/diag` has an **MMA probe** that reports whether fighter stats, a moneyline and post-fight stats are available from the host.

---

## 9. Re-runs: the ledger-aware behaviour (latest feature)

Shipped 2026-11-11 (commit `ba40a22` + friends). Problem it solves: a re-run of the same slate used to fill its pick limit and risk cap with bets that already existed (then discarded them as duplicates) while a genuinely new candidate was rejected as "card is full".

How it works now (`engine.ts` §"What is already on the ledger", `selection.ts` `ledger` input, `candidate.ts` `clusterFor`):
1. Load every prediction already on the ledger for `slateDate` + the run's sports (**any owner — the ledger is shared**).
2. `pool` = candidates that are **not** duplicates (same `dedupeKey`) **and** whose angle `sport:eventId:cluster` is not already taken (a lean takes its angle too).
3. `selectCard({cands: pool, ledger: seed})`: existing bets **do not** consume this card's pick limit or daily cap, **but they do** count toward the per-game limits (pick count, 2u per game, clusters, contradictions).
4. `selectCard({cands: all})` (no ledger) decides which already-released picks the council **still endorses** → `standing`. They are shown for context ("already on your ledger — not re-staked"), listed in `council.repeats`, put in `runs.carried`, and **never re-inserted or re-graded**.
5. Headlines: `N PLAYS · Xu RISKED` · `NOTHING NEW — N EARLIER PICKS STAND` · `PASS — NO PLAY [· N LEANS]`. `council.noPlay` is true only when there are no new picks **and** no standing picks.
6. `GET /api/runs` returns **two windows**: the last 50 *productive* runs (released ≥ 1 new pick, play or lean) and the last 100 *idle* runs, merged newest-first, each tagged `productive: boolean`. Idle runs (passes, "nothing new") belong in a **Log**, and a pile of them can never push real runs out of the Ledger. The Ledger tab's **Ledger | Log** toggle is driven by this flag (`src/components/ledger.ts`, §14).

Tests: "re-running the same slate never duplicates a wager…", "duplicates do not use up a re-run's slots…", "runs that add nothing new go to the Log, not the Ledger…" in `tests/pipeline.integration.test.ts`; `selection.test.ts` and `mma-picks.test.ts` (cluster parity) cover the rest; `tests/ledger.test.ts` and "the Ledger/Log split the UI draws agrees with what GET /api/runs really returns" pin the UI side against real payloads.

---

## 10. Grading

`gradePending()` (`engine.ts`), triggered by **POST /api/grade** (the "sync & grade" buttons — there is no scheduler, K-15/§19):
- Takes up to 250 pending picks whose `start_time` is > 45 minutes ago, fetches finals per `slateDate|sport` (cached per call), and settles with the pure functions in `grading.ts` (`settleTeam`, `settleMma`).
- **MMA** sig-strike/takedown props need post-fight stats from ESPN's core API; if unreadable they stay pending and are **voided after 3 days** (stake returned). Other picks with no final result are **voided after 5 days** (postponed/cancelled).
- Only staked picks (`units > 0`) credit agents; leans are shadow picks. Duplicates never exist, so nothing is credited twice.
- Legacy v4 fight rows (no structured market) are rebuilt by `legacyMma()` so old results still grade.
- **Known quirk:** overlapping grade calls both "grade" the same rows (response counters double); see K-10.

---
## 11. Data model

Four tables. **Drizzle** definitions in `src/db/schema.ts`; the **authoritative DDL** is `ensureSchema()` in `src/lib/schema.ts` (memoised per process, retried after a transient failure such as Neon waking from scale-to-zero).

| Table | What it holds | Notable columns |
|---|---|---|
| `agents` | the 17-agent roster (only the `house` copy is used — K-11) | `id` (house rows = bare key, others `owner:key`), `owner_id`, `agent_key`, `codename`, `layer`, `prompt`, `rating`, `wins/losses/pushes`, `improvements` (JSON log, last 12), `prompt_version` |
| `runs` | one row per launched pipeline | `id`, `owner_id`, `slate_date`, `sports[]`, `include_events[]`, `markets[]`, `discipline`, `status` (running/completed/failed), `mode` (heuristic/llm), `games_found/analyzed/skipped`, `trace` (console lines), `carried` (ids of standing picks shown on this run), `council` (decision JSON), `is_public` (legacy, K-08) |
| `predictions` | the **ledger**: one row per wager | `dedupe_key`, `run_id` (FK, cascade), `sport`, `event_id`, `category`, `pick`, `line_label`, `odds`, **`units` (0 = lean)**, `confidence` (v5: win-prob %), `edge` (v5: EV %), `model_prob`, `market_prob`, `price_source` (book/model), `min_price`, `engine_version` (5 = current; legacy rows default 4), `agents[]`, `grade` (`GradeSpec` JSON), `outcome` (pending/win/loss/push/void), `final_score`, `graded_at` |
| `user_bets` | the personal tracker | `owner_id`, `prediction_id` (FK), `stake`, `odds`, `note`, `result_override`, `placed_at`; unique `(owner_id, prediction_id)` |

**Indexes — only `ensureSchema()` knows three of them:** `predictions_owner_dedupe_idx` (unique `owner_id, dedupe_key`), `runs_owner_idx`, `predictions_pending_idx`. The Drizzle schema declares just `user_bets_owner_prediction_idx` (plus `agents_owner_key_idx` lives in SQL). Treat `ensureSchema()` as authoritative. The README still offers `npx drizzle-kit push`; that is fine on an **empty** database (the app adds the SQL-only indexes on its first request), but **avoid it on a live database** — it only knows part of the picture and may propose dropping those indexes (untested).

**JSON types** (all in `src/db/schema.ts`): `GradeSpec` (side, line, teamAbbr, player, stat, segment, `mma`, `fightRef`), `MmaGrade` (a tagged union: ml · rounds · distance · start_round · spread · method · sigstr · td), `CouncilDecision` (headline, memo, avoided, repeats, discipline, exposure, considered, passed, noPlay, leans, funnel), `TraceEntry`, `ImprovementEntry`. `BetCategory` still lists legacy categories (`nrfi`, `1h_spread`, `fight_method`…) **so old rows keep rendering and grading** — don't delete them from the union.

**`dedupeKey`** = `slateDate | sport | eventId | category | side | line | teamAbbr | player | stat | segment` (+ `fighter:method` for method bets, `fighter` for strikes/takedowns). Fight picks normalise `FIGHT` → `FULL` so a v5 pick can't be counted twice against a legacy row. The unique index is per owner, but **every dedupe lookup in the engine is global**, i.e. effectively one ledger shared by everyone.

**Adding a column or table:** (1) add it to `src/db/schema.ts`; (2) add an idempotent statement to `src/lib/schema.ts`; (3) extend `tests/schema-upgrade.test.ts` (it builds a real v4-shaped database from `tests/legacy-schema.ts` and upgrades it); (4) mirror any client-visible field in `src/components/types.ts`. JSON-typed fields (like `CouncilDecision`) need no migration.

---

## 12. API surface

All handlers use `export const dynamic = "force-dynamic"`. Route modules may **only export handlers/config** (Next.js rule) — keep helpers private or in `src/lib`. In Next 16 dynamic-route `params` is a `Promise`.

| Method · Path | Auth | Purpose and notes |
|---|---|---|
| `GET /api/slate?date=YYYY-MM-DD&sports=nba,ufc` | none | Game board. 75 s per-instance cache. Returns `games`, `degraded[]` (what enrichment was skipped for time), `providers`, `counts`. 400 on bad date / no sports; 502 if ESPN is down. |
| `GET /api/runs` | none (public ledger) | Up to **50 productive + 100 idle** runs (§9), newest first, each with `predictions` (fresh, then `carried`), `isViewerRun`, **`productive`**. `ownerId` is scrubbed. |
| `POST /api/runs` | none (owner header optional) | Body `{date, sports[], markets[], includeEvents[], discipline}`. Unknown sports dropped; max 8 sports / 400 events / 40 markets. Inserts the run, then runs the pipeline **inline** (Vercel/Lambda, `maxDuration` 60) or **fire-and-forget** (long-lived host). Returns `{id}`. |
| `GET /api/runs/[id]` | none | One run + picks (fresh + carried). The UI polls it every 1.3 s while `status = running`. **Does not** include `productive` / `isViewerRun`. |
| `GET/POST /api/runs/public` | POST: caller must own the run | Legacy public-feed toggle. UI never calls GET; the toggle isn't wired to any button (K-08). |
| `POST /api/grade` | none | Settles pending picks + ratings (§10). |
| `GET /api/agents` | none | Roster (house copy), model label computed live from the caller's keys, plus `isAdmin`. |
| `PATCH /api/agents` | **admin** | Body `{id, prompt ≥ 20 chars}`; edits the **house** agent only (it used to rewrite every workspace's copy — test guards this). |
| `POST /api/agents` | **admin** | Body `{id}`; resets that agent to the built-in playbook (archives the old prompt). |
| `GET/POST/PATCH/DELETE /api/bets` | **private workspace id required** (the shared `house` id is refused, 400) | Personal tracker. `GET ?format=csv` downloads. POST upserts `{predictionId, stake ≤ 50, odds (American), note}`; PATCH sets a manual result; DELETE `?predictionId=`. Max 5 000 bets per owner. |
| `POST /api/keys/test` | none | One-token probe of each key the visitor supplied. Keys are never stored. |
| `GET/POST /api/setup` | none | Creates tables, seeds the roster for the *requesting* owner id, returns counts. |
| `GET /api/diag` | none | Self-test: database, ESPN probe (3 dates × 5 leagues), MMA probe, LLM providers. Mobile-friendly. |
| `GET /api/version` | none | `RELEASE` metadata + a live-fire of the MMA model (errors loudly if an upload was partial). |
| `GET /api/health` | none | `select 1` → `{ok}`. |

**Request headers:** `x-neonslip-owner` (workspace id, ≥ 8 chars `[A-Za-z0-9_-]`, else treated as `house`) · `x-neonslip-keys` (base64 JSON of the visitor's LLM keys) · `x-neonslip-llm` (`on` / `off`; absent ⇒ **enabled**, which matters for non-browser callers).

---

## 13. Identity, privacy and security model

There are **no accounts**. The design deliberately trades authentication for zero-friction use:

- **Workspace id** (`neonslip.owner.v1` in `localStorage`, shape `w` + 24 alphanumerics, generated client-side) is a **bearer credential**. It files the person's runs, bets and (if admin) unlocks prompt editing. Anyone holding it *is* that user. It is sent as `x-neonslip-owner` on every request, **never returned by the server** (`scrub()`), and can be copied/pasted to another device in *My Bets*.
- **Admin** = the request's workspace id equals the `ADMIN_OWNER_ID` env var. Only admin may PATCH/POST `/api/agents`. The Ledger's "Official / Community" filter just means "runs filed by the admin workspace vs everyone else" (`isViewerRun` is a boolean, the id itself is never sent).
- **The ledger is shared and public**: every run and pick (sans owner id) is readable by anyone who opens the site. Pick dedupe is global. **Bets are private** to their workspace id.
- **LLM keys** ("bring your own AI") live only in the visitor's `localStorage` (`neonslip.vault.v1`) and ride a single request as `x-neonslip-keys`. They are never written to the DB or logs. If the host sets **server** keys (`GEMINI_API_KEY` etc.), every visitor's run can use them — a cost decision for the owner (K-09).
- **LLM output is untrusted**: it can only reference candidates by id, must give a reason, and is clamped (§7). Parsing tolerates fences/prose (`extractJson`).
- **Unauthenticated, unthrottled endpoints that cost compute or money**: `POST /api/runs`, `POST /api/grade`, `GET /api/setup`, `GET /api/diag` (it also echoes DB error text and the last upstream request). Fine for a private deployment; **review before sharing the URL widely** (K-09).
- **Input bounds** exist on runs (sports/events/markets), bets (stake ≤ 50u, 5 000 per owner, note ≤ 200 chars) and prompts (≤ 6 000 chars).

---

## 14. Frontend map and conventions

Single page (`src/app/page.tsx` → `AppShell`), **four tabs**: **War Room** (control deck → kernel console → the slip → leans → slate board) · **Agent Roster** · **Prediction Ledger** (with a **Ledger | Log** toggle) · **My Bets**. `AppShell` owns all state and the three flows: *launch* (POST, then poll `/api/runs/[id]` every 1.3 s), *grade* (`/api/grade`, then reload runs/agents/bets), *bets* (save/remove/override).

- **Which run does the War Room show?** `cardForDate`: the active run once it finishes, else the **newest run in `runsData` with the same date and the same set of sports** (any owner — the ledger is shared). Plays are picks with `units > 0`; leans are `units === 0`.
- **Ledger vs Log** (`src/components/ledger.ts` — pure and tested; the view only draws it). **Ledger** = runs that released something new, plus a run still in progress and a failed run that left picks behind. **Log** = passes, re-runs where every pick already stood ("nothing new") and failures that left nothing. The tab badge counts finished Ledger runs. Row labels come from `runKind()`: `FAILED`, `NOTHING NEW · N standing`, `PASS · no play`, `+N standing`. A Log run releases nothing of its own, so records come from Ledger runs only.
- **Ledger stats** (`runs-view.tsx → computeStats`) dedupe by `dedupeKey`, tally leans separately, and keep model-priced P/L apart. Engine filter: all / v5 / legacy (v4).
- **After a re-run the slip shows the day's whole card** — this run's new plays plus earlier ones that still stand (flagged "already staked"). The commissioner's headline counts only what the run adds, so the exposure figure shows the total with a `Xu new · Yu on ledger` line, and the funnel adds `N already on your ledger`.
- **`components/types.ts`** hand-mirrors the API (kept free of server imports so the bundle stays clean). When an API field is added, add it here too — the compiler won't tell you it's missing (the `productive` flag went unused until 5.2.0 for exactly this reason).
- **Fetching**: use `vaultFetch` (attaches owner id + keys + LLM mode) or `ownerFetch` (owner id only — for endpoints that don't need keys, e.g. bets). Don't call `fetch` directly for the app's own API.
- **Browser storage keys**: `neonslip.owner.v1`, `neonslip.vault.v1`, `neonslip.llm-mode.v1` (default **off**), `neonslip.discipline.v1`.
- **Look and feel**: dark "neon capper" theme. Tokens in `globals.css` `@theme` — abyss `#03050b`, neon green `#37ff8b`, cyan `#39d5ff`, violet `#9d7bff`, magenta `#ff3d81`, amber `#ffb020`, red `#ff4757`; fonts Space Grotesk (display) + JetBrains Mono (data). Reuse the existing utility classes (`panel`, `panel-glow`, `clip-tag`, `rise`, `blink`, `title-stroke`, `scanlines`…) and primitives in `ui.tsx` (`Panel`, `Chip`, `OutcomeChip`, `CategoryChip`, `ProbBar`, `NeonButton`). Colours are written as arbitrary Tailwind hex values (`text-[#37ff8b]`). **Mobile first**: the owner mostly uses a phone — test narrow widths, keep tap targets large, keep tabs scrollable.
- **Honesty in copy**: always label BOOK vs MODEL price; show "play at X or better" for model-priced picks; never imply a lean is a recommendation.

---

## 15. Testing

`npm test` → `tsx --test "tests/*.test.ts"` (Node's built-in runner). **160 tests in 14 files, ~65 s.**

| File | Tests | Covers |
|---|---|---|
| `pipeline.integration.test.ts` | 19 | The real pipeline on **real SQL (PGlite, in-memory Postgres)** against a **fake ESPN**: slate parsing, MMA stats flow, re-runs and the Ledger/Log windows, passes, LLM-review bounds, leans, grading every market, voiding, the bet tracker, API privacy, admin edits |
| `ledger.test.ts` | 6 | the Ledger-vs-Log rules (pure): every kind of run, flag-absent fallback, failed / in-progress edge cases, the tab badge |
| `selection.test.ts` | 25 | gates, caps, clusters, leans, near-misses, ledger-aware selection |
| `team-model.test.ts` | 20 | market view, signals, candidate construction |
| `mma-model.test.ts` · `mma-picks.test.ts` | 16 · 11 | joint model maths, floors, base-rate deviation, `clusterFor` parity |
| `grading.test.ts` | 16 | pure settlement of team + MMA bets |
| `edge.test.ts` | 12 | de-vig, EV, Kelly, stake rounding |
| `markets.test.ts` | 9 | market catalogue and filters |
| `review.test.ts` | 8 | bounded LLM review |
| `bets.test.ts` | 7 | tracker validation / settlement / summary |
| `espn-parse.test.ts` | 6 | ESPN payload parsers |
| `schema-upgrade.test.ts` · `schema-retry.test.ts` | 4 · 1 | v4 → v5 database upgrade; bootstrap retry |

**How the harness works.** The app's lazy `db` proxy reads `globalThis.__arenaNextJsPostgresqlDb`; tests assign a PGlite-backed Drizzle instance *before* importing the app. `tests/fake-espn.ts` installs a fake `fetch` that serves payloads shaped like the real ones, so the **real parsing code runs**. Its `FakeState` toggles scenarios (`phase` pre/final, `mmaMoneyline`, `fightStats`, `failSummary`, `leanGame`, `extraEdgeGame`, a scripted `llm`). `tests/helpers.ts` builds `GameInfo` / bout fixtures.

**Manual / visual run against the fake feed:** `NODE_OPTIONS="--import tsx --import ./tests/preload-fake-espn.ts" next start` — then `echo final > /tmp/fake-phase` to finish the games, `touch /tmp/fake-lean` for a lean, `touch /tmp/fake-extra` for a later new play. Needs `DATABASE_URL`.

**Checking UI behaviour without a browser** (scratch work — don't commit it; the repo has no component tests). Used to verify the 5.2.0 screens:
1. In a throwaway test, build the scenario on PGlite + fake ESPN and write the real `GET /api/runs` JSON to a file.
2. Bundle the component: `npx esbuild src/components/<file>.tsx --bundle --platform=node --format=cjs --jsx=automatic --external:react --external:react-dom --external:react/jsx-runtime --outfile=/tmp/x.cjs`.
3. In a scratch folder `npm i jsdom`; render with `react-dom/client` inside `React.act`, click with `dispatchEvent(new window.MouseEvent("click", { bubbles: true }))`, and assert on `document.body.textContent`.
4. Run the same checks against the **old** file (`git show HEAD:<path>`) to prove they can fail.

This sees text and structure — **not** layout or colour. Look at the deployed page on a phone for that.

**What to add when you change…**

| You changed | Add / update |
|---|---|
| pricing, gates, sizing | `team-model` / `selection` / `edge` tests |
| a market or category | `markets`, `mma-picks` (incl. cluster parity), `grading`, and a grading case in the integration test |
| ledger / re-run behaviour | integration tests ("re-running…", "duplicates do not use up…", "Log, not the Ledger") |
| the Ledger/Log screens or their rules | `ledger.test.ts` + the "Ledger/Log split the UI draws…" integration test; then render-check the component (below) |
| the schema | `schema-upgrade.test.ts` |
| an API field | the integration test that reads it **and** `components/types.ts` |

Everything above ran against **fake** ESPN. The live feed (unofficial, can change or block) is only checkable on the deployed site via `/api/diag`.

---

## 16. Deploy and operations

**Hosting** (README): GitHub → **Vercel** + **Neon** Postgres (free tiers). Render is the documented long-lived alternative. Vercel's Git integration normally redeploys on every commit to `main` (confirm that is how the owner's project is wired). There is no CI.

**First-time / fresh database:** set `DATABASE_URL` (Neon *pooled* string), redeploy, open `/api/setup` once. The app also self-bootstraps on first use, so this is mainly a check.

**Environment variables**

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes at runtime** (not for `next build`) | pool max 4 |
| `ADMIN_OWNER_ID` | optional | the owner's workspace id (copy it from *My Bets*). Unlocks prompt edit/reset. **Missing from the README** (K-07) |
| `OPENROUTER_API_KEY` · `OPENROUTER_MODEL` | optional | default model `nvidia/nemotron-3-super-120b-a12b:free` |
| `GEMINI_API_KEY` · `GEMINI_MODEL` | optional | default `gemini-2.5-flash` |
| `XAI_API_KEY` · `GROK_MODEL` | optional | default `grok-3-mini` |
| `OLLAMA_BASE_URL` · `OLLAMA_MODEL` | optional | default `llama3.1` (local daemon) |
| `VERCEL`, `VERCEL_REGION`, `AWS_LAMBDA_FUNCTION_NAME` | set by the host | presence ⇒ run the pipeline inline |

**Verify an upload landed** (the owner's substitute for CI): open **`/api/version`** (shows `version`, `built`, features, and a live MMA-model probe — it errors if an upload was partial), **`/api/health`**, and **`/api/diag`** (database · ESPN across today + 2 days · MMA probe · LLM providers). If a build fails on the host, the Vercel build log shows the TypeScript error; `next build` runs the type-check.

**Limits to remember:** Vercel Hobby functions time out (the code assumes 60 s: slate 16 s, review 20 s, LLM skipped after 32 s). ESPN is an **unofficial** API; the client rotates user-agents because ESPN's edge 403s browser-like agents. MMA has no sportsbook prices; NHL goalie news and detailed college injuries are not in the feed.

---
## 17. Where we left off

**Last delivery — 2026-11-24, v5.2.0, built on `041948d`.** The Ledger / Log UI that the 2026-11-11 backend work was waiting for (resolves K-01, K-03, K-06).
- `src/components/ledger.ts` *(new)* — the pure Ledger-vs-Log rules · `runs-view.tsx` — the **Ledger | Log** toggle and honest row labels · `types.ts` — `productive`, `funnel.repeats` · `app-shell.tsx` — the tab badge counts Ledger runs · `war-room.tsx` — funnel shows `N already on your ledger`, exposure shows `Xu new · Yu on ledger` · `src/lib/release.ts` — 5.2.0.
- Tests: `tests/ledger.test.ts` *(new, 6)* and one new integration test ("the Ledger/Log split the UI draws agrees with what GET /api/runs really returns").

**After the owner uploads it, confirm:** `/api/version` reports `5.2.0` with `ledgerAwareReruns` and `ledgerLogSplit`; the Ledger tab shows **Ledger · N | Log · N**; the Log lists passes, "NOTHING NEW" re-runs and failures.

**Defaults chosen without the owner** (change on request): idle runs live in a **toggle inside the Ledger tab** (not their own tab); the exposure figure shows **both** the slate total and the new-vs-on-ledger split; a run still in progress stays in the Ledger; a failed run that left picks behind stays in the Ledger too.

**Not verified:** how the new screens *look* in a browser or on a phone — they were checked from a real `/api/runs` payload in a simulated DOM (text and structure, not layout or colour; §15) — and the live deployment.

**What's next (owner's call, §19):** the hygiene bundle — delete the 23 stale scripts (K-02), lint to green (K-04), a lockfile (K-05), README tidy (K-07), the public-feed chain (K-08) — or K-16 (a failed run blanks the War Room).

---

## 18. Known issues and tech debt

Severity: **Medium** = user-visible inconsistency or unfinished work · **Low** = hygiene / minor · **Decision** = needs the owner · **Info/Risk** = awareness.

| ID | Sev | Issue and evidence | Suggested fix |
|---|---|---|---|
| **K-02** | Medium | **23 stale patch scripts in the repo root** (`add_force_improve.py`, `fix_*.py` ×4, `patch_*.py` ×17, `rewrite_scope.js`), all added in one commit on 2026-10-06 (`0c7d556`), before the v5 rewrite; nothing references them. A dry run on a scratch copy of HEAD: 18 are no-ops, but **5 would still modify live code** — `patch_agents.py` (removes ~128 lines of `agents.ts`, i.e. the built-in roster), `patch_mlb_props.py` (adds pitcher-strikeout props that nothing grades), `patch_ui.py`, `patch_agents_api.py`, `add_force_improve.py` (re-adds a "force improve" button that now means *reset*). **Never run them.** | Delete all 23. With a terminal: `git rm add_force_improve.py fix_*.py patch_*.py rewrite_scope.js`. Without: GitHub → open each file → ⋯ → *Delete file*. |
| **K-04** | Low | **Lint is red: 4 errors + 1 warning**, all UI. `app-shell.tsx:74` (`react-hooks/refs` — `activeIdRef` is assigned during render and **never read**; delete lines 73–74), `:78`, `:226`, `:227` (`react-hooks/set-state-in-effect`), `layout.tsx:17` (custom Google Font link). `runs-view.tsx` has three `eslint-disable react-hooks/exhaustive-deps`. `next build` does not lint, so deploys aren't blocked. | Delete the dead ref; restructure the effects (or scope-disable with a reason); move fonts to `next/font`. |
| **K-05** | Low | **No `package-lock.json`** committed; three caret ranges (`lucide-react ^1.48.0`, `@electric-sql/pglite ^0.5.8`, `tsx ^4.23.15`); no `engines`. Installs can drift between deploys. | Generate a lockfile and commit it; add `"engines": {"node": ">=22"}`. |
| **K-07** | Low | **README drift**: "Data — free + keyless" and "Stack" each appear twice (lines 128/171 and 140/175); model defaults are stale (README: `google/gemini-2.0-flash-001`, `gemini-2.0-flash`; code: `nvidia/nemotron-3-super-120b-a12b:free`, `gemini-2.5-flash`); `ADMIN_OWNER_ID` isn't mentioned; no mention of re-run behaviour or the Ledger/Log split. (The pointer to this file is already in.) | Edit the README. |
| **K-08** | Low | **Dead public-feed chain**: `togglePublic()` in `runs-view.tsx` is never called (and `publishing`, `Globe`, `Lock` are unused); `GET /api/runs/public` is never fetched; the `is_public` column feeds only that endpoint. | Remove, or finish and wire it (owner's call). |
| **K-09** | Decision | **Unauthenticated, unthrottled endpoints** that cost compute/money: `POST /api/runs` (uses *server* LLM keys if set), `POST /api/grade`, `GET /api/setup`, `GET /api/diag` (echoes DB error text + last upstream request). Acceptable for a private deployment. | Before sharing widely: rate limits, an optional access code, trim `/api/diag` output. |
| **K-10** | Low | `gradePending()` has no concurrency guard (the per-row `UPDATE` has no `outcome = 'pending'` predicate). In a harness test two overlapping calls both reported `graded: 3` (6 for 3 picks); agent ratings were **not** double-credited (absolute writes) in lock-step or staggered runs, but a narrow window remains. | Guard the UPDATE (`... and outcome = 'pending'` + `returning`) and credit only rows actually changed. |
| **K-11** | Low | **Vestigial per-owner agent rosters**: the pipeline, ratings and admin edits only use `house`; `GET/POST /api/setup` and `ensureAgentsSeeded(owner)` can still create unused per-owner rows. | Seed only `house`, drop the per-owner path. |
| **K-12** | Info | **Template leftovers**: `package.json` name is `nextjs-postgresql-template`; the DB handle lives on `globalThis.__arenaNextJsPostgresqlDb` (**the tests depend on that exact key**); both `drizzle.config.json` and `drizzle.config.ts` exist. | Rename only together with the test harness; keep one drizzle config. |
| **K-13** | Info | **Three cluster definitions** that must agree: `clusterOf` (`team-model.ts`), `CLUSTER_OF` (`mma-picks.ts`), `clusterFor` (`candidate.ts`, used on stored picks). Guarded by a parity test in `mma-picks.test.ts`. | Consolidate into `clusterFor` when next touching markets. |
| **K-14** | Risk | **ESPN is unofficial** (shape changes / blocking possible); MMA has no sportsbook prices; no NHL goalie data; thin college injuries. Everything was tested against a fake feed. | Watch `/api/diag`; keep parsers defensive; never invent data when a fetch fails (the engine passes the game instead). |
| **K-15** | Info | **No CI and no scheduler.** Uploads go straight to deploy; the 64-second suite is never run automatically; grading happens only when someone taps "sync & grade". | See §19. |
| **K-16** | Low | **A failed run blanks the War Room for its date + sports.** `cardForDate` (`app-shell.tsx`) takes the newest run for the date regardless of status, and the slip / pass panels render only for `completed`. Rendering the real `WarRoom` with a failed run as the card shows no slip, no pass panel and no failure message — the earlier good card is hidden until another run succeeds (same for a run stuck in `running`). *Found while verifying 5.2.0; pre-existing, not caused by it.* | Prefer the newest *completed* run for the slot and show a small "last run failed" note — the owner decides. |

**Resolved:** K-01 Ledger/Log UI · K-03 exposure vs headline · K-06 release bump — all in 5.2.0 (2026-11-24). *IDs are never reused.*

**Not verified in the session that wrote this file:** the live deployment and live ESPN (the sandbox could not reach them); how screens look in a browser or on a phone (the Ledger/Log screens were checked from real data in a simulated DOM — text and structure only; other UI statements come from reading the code); real LLM providers (tests use a scripted fake); whether `ADMIN_OWNER_ID` / server LLM keys are set; behaviour of a very large slate within Vercel's 60 s limit.

---

## 19. Roadmap

*Reconstructed from the repo — what was in flight, what the README says it wants to learn, and the issues above. **Only the owner sets priorities**; confirm them at the start of a session. Items marked (proposed) are suggestions, not commitments.*

### Now — hygiene, in one small delivery
1. Delete the 23 stale scripts (K-02).
2. Get lint to green (K-04); commit a lockfile + `engines` (K-05).
3. Clean the README (K-07); remove or finish the public-feed chain (K-08).
4. K-16 — don't let a failed run blank the War Room (needs a small owner decision on what to show).
5. (proposed) **CI**: a GitHub Actions workflow running `npm ci`, `npm test`, `npm run typecheck:tests`, `npx next build` on every push — the owner has no terminal, so this is the only automatic safety net. Needs K-05 first.

*Done in 5.2.0:* the Ledger / Log UI, the exposure reconciliation, the release bump.

### Later — product and engine (all proposed; need the owner's say)
6. **Calibration and bar report**: from graded v5 rows, show realised win rate vs `modelProb` per bucket and *plays vs leans* ROI, so the owner can see with data whether the bar is too high or too low (the README introduces leans for exactly this). All data is already in `predictions`; needs a read-only endpoint + a view.
7. **Auto-grading**: a scheduled call to `/api/grade` so the ledger, ratings and bets update without tapping "sync". Do K-10 first; check the host plan's cron limits; decide on auth (K-09).
8. **Closing-line value**: store a second price near game time to measure whether picks beat the close — the strongest evidence of real edge. Limited by what ESPN exposes.
9. **Hardening before wider sharing** (K-09). 
10. **Data gaps** — NHL goalie, college injuries, MMA moneylines — limited by the free feed; anything paid is a product decision.
11. Consolidate cluster definitions (K-13) and drop vestigial rosters (K-11).

### Decisions waiting on the owner
- Idle runs are now a **toggle inside the Ledger tab** — would you rather they had their own tab?
- After a re-run the exposure figure shows **both** the slate total and the new-vs-on-ledger split — keep that, or show only one?
- Keep or remove the public/community feed code (K-08)?
- Is the site private or shared — how much protection (K-09)?
- Priority: hygiene first, or features first?

---

## 20. Removed on purpose — do not re-add

| Removed | Why |
|---|---|
| A forced ten-pick card / pick quotas | A forced card dilutes win rate. A pass is a valid result. |
| Rating teams from W-L records and betting disagreements with the market | The book is better informed; big gaps were the model being wrong. |
| LLM "self-improvement" that rewrites prompts after 8 graded bets (incl. "force improve") | 8 bets is noise; rewrites piled up into contradictory prompts and changed nothing for deterministic scouts. Replaced by z-test gating and *reset to built-in playbook*. |
| LLM-invented player lines (old PROPS behaviour) | An LLM may only *review* existing candidates by id. |
| NRFI / YRFI | Its Poisson model was miscalibrated (it would pick YRFI on nearly every game) and there is no data to price it. (`nrfi` stays in `BetCategory` so old rows grade.) |
| Boxing | Removed from the sports list. |
| The MATCHUP scout | Retired; `ensureAgentsSeeded` deletes stale agent rows. |
| Crediting every council agent on every pick | Ratings moved in lock-step and meant nothing. Agents are now stamped only on picks they backed. |
| Defaulting a missing ±1.5 price to −110 | It manufactured fake edges on exactly the bets staked most. |
| Updating agents by `agentKey` alone | It rewrote every workspace's copy. Edits target the house roster only (test-guarded). |
| Deleting a run that produced nothing | It hung the client. Passes are kept (test-guarded). |

---

## 21. Glossary

- **Play** — a released pick with a suggested stake (`units > 0`). **Lean** — a small positive edge below the bar, **no stake** (`units = 0`), graded separately. **Pass** — a run that releases nothing.
- **Ledger** — the shared record of every released pick. **Log** — (planned UI) runs that added nothing. **Standing / carried pick** — an earlier pick the council still endorses on a re-run; shown, never re-staked or re-graded.
- **Book price** — a posted sportsbook number. **Model price** — our own number (ESPN has no line); picks state a **price floor**: "play it at X or better".
- **De-vig** — remove the bookmaker's margin from a two-way market to get a fair probability. **EV** — expected value per unit staked at the price on offer. **Kelly** — bet-size fraction from edge and odds; we use **quarter-Kelly**, rounded *down* to 0.25 u. **Unit** — 1 % of a 100-unit bankroll.
- **Discipline** — Strict / Standard / Loose: the volume-vs-quality dial. **Council** — the selection layer (HISTORIAN · COMMISSIONER · RISK). **Scouts** — QUANT · MEDIC · CHRONO · SHARP · PROPS. **Reviewer** — a bounded LLM pass.
- **Bucket** — `sport:category` (MMA promotions share `mma:`), the unit of track-record gating. **Cluster / angle** — correlated bets that count as one (`side`, `total`, MMA `result` / `duration`…).
- **`dedupeKey`** — the identity of a wager (§11). **HOUSE** — the shared workspace id `house`. **Workspace id** — the client-generated bearer id in `localStorage`. **BYO keys** — the visitor's own LLM keys, sent per request.
- **v4 / legacy** — the pre-2026-10-19 engine (`engine_version = 4`). **v5** — the market-anchored engine. **DWCS** — Dana White's Contender Series. **Finish handicap** — MMA "spread": −1.5 must win by KO/TKO/submission.

---

## 22. Changelog and project history

**Reconstructed from git** (every commit is "Add files via upload", so there are no messages to read — dates and files are the evidence):

| Date | What happened |
|---|---|
| 2026-09-26 → 10-12 | **v1–v4 era.** First upload 09-26. LLM-heavy agent cluster with prompt "self-improvement" and a forced card; ESPN slate; BYO keys; `/api/diag`; MMA fighter stats (10-05). 23 one-shot patch scripts accumulate (10-06). |
| 2026-10-19 | **v5.0.0 "Market-Anchored Engine"** — a rewrite: `team-model`, `selection`, `edge`, `health`, `discipline`, `review`, `candidate`, `grading`, `mma-model`, `mma-picks`, the **My Bets** tracker, `scrub`, schema upgrade; README rewritten. |
| 2026-10-20 | The **test suite** and the **fake ESPN** (today's 160 tests grew from this). |
| 2026-10-22 | Tuning (`discipline`, `engine`, `runs/public`). |
| 2026-11-01 | **v5.1.0** — leans, funnel diagnostics, puck-line integrity; UI for leans and the funnel. |
| 2026-11-11 | **Ledger-aware re-runs**; `/api/runs` Ledger/Log windows; the UI half was not done at the time (K-01; finished in 5.2.0). |
| 2026-11-23 | This handoff written. No code changed. Added a Known-issues audit (tests, typecheck, build and lint were run; the 23 patch scripts were dry-run on a scratch copy; the grading race was probed and **not** reproduced as a ratings double-credit). |
| 2026-11-24 | **v5.2.0** — the Ledger / Log UI (K-01), exposure reconciled with the headline (K-03), release bump (K-06). First delivery as a zip; this file is refreshed with every delivery. |

### Session log (newest first — append an entry every session)

```text
### YYYY-MM-DD — <short title>
- Changed:   <files, full paths>
- Why:       <one or two lines>
- Verified:  tests N/N · typecheck · typecheck:tests · build · lint (state)
- Release:   <version if bumped>
- Left open: <what remains, and which K-/roadmap items it touches>
```

### 2026-11-24 — Ledger / Log UI, v5.2.0
- Changed:   `src/components/ledger.ts` (new) · `src/components/runs-view.tsx` · `src/components/types.ts` · `src/components/app-shell.tsx` · `src/components/war-room.tsx` · `src/lib/release.ts` · `tests/ledger.test.ts` (new) · `tests/pipeline.integration.test.ts` · `HANDOFF.md`
- Why:       finish the UI half of the 2026-11-11 ledger-aware re-runs (K-01), reconcile exposure with the headline (K-03), bump the release (K-06)
- Verified:  tests 160/160 · typecheck · typecheck:tests · `next build` · lint unchanged (4 errors + 1 warning) · a real `/api/runs` payload rendered in a simulated DOM (20 Ledger/Log checks + 12 War Room checks; the Ledger checks fail against the old view) · new tests fail when the helper is deliberately broken
- Release:   5.2.0
- Left open: K-02, K-04, K-05, K-07, K-08 hygiene; new K-16 (failed run blanks the War Room); layout/colour on a phone not seen

### 2026-11-23 — Handoff document created
- Changed:   `HANDOFF.md` (new); `README.md` (one pointer line under the title — nothing else changed; optional upload)
- Why:       so any new chat can continue correctly: how it works, rules, known issues, roadmap, where we left off
- Verified:  baseline `ba40a22` — tests 153/153 · typecheck clean · typecheck:tests clean · `next build` OK · lint 4 errors + 1 warning
- Release:   none (still 5.1.0)
- Left open: K-01 (Ledger/Log UI) is the next task; K-02 cleanup; owner to confirm roadmap priorities (§19)
- Revised:   same day, per the owner's instruction — chats deliver **one zip** (changed files + the updated `HANDOFF.md`), `HANDOFF.md` is refreshed with **every** delivery, the staleness check is keyed to a *base commit*, and the kickoff text is now the owner's own wording (§1, rules 3 and 10)
