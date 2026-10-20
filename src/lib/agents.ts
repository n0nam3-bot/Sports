import { db } from "@/db";
import { agents, type AgentRow, type ImprovementEntry } from "@/db/schema";
import { and, eq, inArray, lt } from "drizzle-orm";
import { ensureSchema } from "./schema";
import { HOUSE } from "./owner";

export interface AgentDef {
  id: string;
  codename: string;
  layer: "scout" | "analyst" | "council";
  sortOrder: number;
  title: string;
  job: string;
  prompt: string;
}

/**
 * Bump when the built-in playbooks change. Rows seeded from an older version
 * are upgraded automatically (the previous prompt and record are archived in
 * the agent's log), so a code update can never be shadowed by stale prompts.
 */
export const PROMPT_VERSION = 5;

/**
 * What each agent ACTUALLY does in the v5 pipeline. Every agent is stamped
 * only on the picks it genuinely backed, so each one builds a distinct,
 * meaningful record instead of all of them sharing the card's results.
 */
export const AGENT_DEFS: AgentDef[] = [
  // ---------------- SCOUTS (Layer 1): produce measurable signals ----------------
  {
    id: "scout-quant", codename: "QUANT", layer: "scout", sortOrder: 1,
    title: "Market-Anchored Probability Scout",
    job: "Starts from the sportsbook's own probability with the vig removed and tilts it toward ESPN's independent matchup projection. Never rates teams from win-loss records.",
    prompt: `QUANT — market-anchored probability.
What it computes: the de-vigged sportsbook probability is the prior. ESPN's published matchup projection (BPI/FPI) is blended in at 20% weight and capped, so it can nudge the price but never override it.
Why: a W-L record is a far weaker predictor than the market. When a crude model disagrees with the market, the model is usually the one that is wrong — and the bigger the gap, the more wrong it is.
Backs a pick only when its tilt points the same way as the pick by at least 3% of one standard deviation of the game margin.
Deterministic: runs the same with or without an LLM.`,
  },
  {
    id: "scout-medic", codename: "MEDIC", layer: "scout", sortOrder: 2,
    title: "Injury & Availability Scout",
    job: "Prices confirmed absences, weighting players who lead their team and ignoring bench names. Refuses to judge a game whose injury report was never fetched.",
    prompt: `MEDIC — availability.
Weights: Out = 1.0, Doubtful = 0.7, Questionable = 0.3. A team leader counts fully; a deep-bench name counts 0.45. At most 3 players per team. Converted to margin by sport.
Only 25% of the effect is kept: public injuries are already in the line, so only the unpriced remainder is potential edge.
Hard rule: if the per-game injury report could not be fetched, the game is passed. "No injuries listed" and "we never looked" are different facts, and the market always knows.
Backs a pick when the net injury effect favours it. Deterministic.`,
  },
  {
    id: "scout-chrono", codename: "CHRONO", layer: "scout", sortOrder: 3,
    title: "Rest & Schedule Scout",
    job: "Quantifies back-to-backs, three-in-four stretches, travel and rest gaps, then keeps only the part the market has not priced.",
    prompt: `CHRONO — rest and schedule.
Penalises the tired side of a back-to-back (more with travel), 3-in-4 stretches, and big rest gaps, using per-sport values. Keeps 35% of the effect because schedules are public and lines already reflect most of it.
Backs a pick when the rest edge favours it. Deterministic.`,
  },
  {
    id: "scout-sharp", codename: "SHARP", layer: "scout", sortOrder: 4,
    title: "Market Integrity & Price Scout",
    job: "Validates the board before anything is bet on it, and backs picks only when the book charges little vig on that side.",
    prompt: `SHARP — market integrity and price quality.
Integrity checks: each two-way market must sum to 100–115% implied (otherwise the data is junk); the spread and moneyline must agree on who the favourite is. A failed check removes the game from consideration.
Price quality: backs a pick only when the vig paid on its side is at most 2 percentage points. Never lays steeper than -350 on a moneyline.
Deterministic.`,
  },
  {
    id: "scout-props", codename: "PROPS", layer: "scout", sortOrder: 5,
    title: "Derived Markets & Props Scout",
    job: "Handles markets with no posted line in our free feed (team totals, halves, quarters, player props). Everything it produces is a MODEL LINE with a line/price you must beat.",
    prompt: `PROPS — derived markets (opt-in only).
There is no posted line for these markets in the free feed, so every number is our own. It uses the player's MEDIAN (not the mean: yardage is right-skewed, so "over the average" loses) and says plainly: "Over only if your book's number is X or lower; never pay worse than Y".
Never invents a line it cannot justify from the data it was given. Held to a higher bar than posted-line markets and staked at a fraction of the size.`,
  },
  // ---------------- Sport specialists: bounded reviewers ----------------
  {
    id: "expert-nfl", codename: "NFL_EXPERT", layer: "scout", sortOrder: 6,
    title: "NFL Reviewer",
    job: "Applies NFL key-number math and sanity-checks every NFL candidate against the injury and rest data supplied.",
    prompt: `You are the NFL_EXPERT. Key numbers: 3 and 7 carry heavy push probability; a half-point either side changes the bet. Large spreads and heavy favourites are priced efficiently.
Review each NFL candidate against ONLY the data supplied (injuries, rest, prices). Veto only for a concrete conflict in that data — e.g. the pick depends on a player the report lists as out.`,
  },
  {
    id: "expert-nba", codename: "NBA_EXPERT", layer: "scout", sortOrder: 7,
    title: "NBA Reviewer",
    job: "Sanity-checks NBA candidates: is a star's absence already in the line, and does the rest edge survive the travel and rotation data?",
    prompt: `You are the NBA_EXPERT. Star absences and back-to-backs are public and mostly priced; an NBA edge exists only when several independent signals stack.
Review each NBA candidate against ONLY the supplied data. Trim when the model counts an injury the line obviously already reflects; veto only for a concrete conflict (the pick depends on a listed-out player).`,
  },
  {
    id: "expert-mlb", codename: "MLB_EXPERT", layer: "scout", sortOrder: 8,
    title: "MLB Reviewer",
    job: "Requires both probable starters before any moneyline, refuses to lay heavy chalk, and reviews candidates against the pitching data supplied.",
    prompt: `You are the MLB_EXPERT. Starting pitching drives baseball prices. Moneylines are only considered when both probable starters are posted. Review each MLB candidate against ONLY the supplied data; a pitching change or scratch listed in the data is a concrete veto.`,
  },
  {
    id: "expert-nhl", codename: "NHL_EXPERT", layer: "scout", sortOrder: 9,
    title: "NHL Reviewer",
    job: "Applies a higher edge bar to hockey (goalie news is not in our feed) and reviews candidates against the data supplied.",
    prompt: `You are the NHL_EXPERT. The starting goalie matters more than any other single fact and is NOT in our free data, so NHL candidates need a larger edge before release. Review each candidate against ONLY the supplied data; do not assume a goalie.`,
  },
  {
    id: "expert-mma", codename: "MMA_EXPERT", layer: "scout", sortOrder: 10,
    title: "MMA Fight Model & Reviewer",
    job: "Prices every UFC / DWCS / PFL market from one joint model of who wins × how × when, and reviews the resulting picks.",
    prompt: `You are the MMA_EXPERT. One joint model — winner × method × round — prices every market (moneyline, finish handicap, total rounds 0.5–4.5, goes the distance, fight to start round 2–5, method of victory, significant strikes, takedowns), so all of them agree with each other.
No sportsbook price is available for most MMA markets, so each pick states our probability, our fair price, and the worst price at which it is still a play. A pick must also differ from the division base rate: the call has to be about THESE fighters.
Review picks against ONLY the supplied stats; veto when a pick contradicts them.`,
  },
  {
    id: "expert-ncaaf", codename: "NCAAF_EXPERT", layer: "scout", sortOrder: 11,
    title: "NCAAF Reviewer",
    job: "Applies a higher edge bar to college football, where injury data is thin and lines are volatile.",
    prompt: `You are the NCAAF_EXPERT. College injury reports are sparse and variance is high, so candidates need extra edge. Review each candidate against ONLY the supplied data.`,
  },
  {
    id: "expert-ncaab", codename: "NCAAB_EXPERT", layer: "scout", sortOrder: 12,
    title: "NCAAB Reviewer",
    job: "Applies a higher edge bar to college basketball and reviews candidates against the data supplied.",
    prompt: `You are the NCAAB_EXPERT. College basketball has hundreds of games and thin public information, so the bar for release is higher. Review each candidate against ONLY the supplied data.`,
  },
  // ---------------- ANALYSTS (Layer 2) ----------------
  {
    id: "analyst-stratega", codename: "STRATEGA", layer: "analyst", sortOrder: 13,
    title: "Convergence Analyst",
    job: "Credited on picks where two or more independent signals agree — the only kind of agreement that counts as evidence.",
    prompt: `You are STRATEGA. One noisy signal is not an edge; independent signals that agree are. Review the shortlist for redundant or overlapping exposure and for picks whose backing is a single signal. You may trim or veto, but only with a concrete reason drawn from the supplied data.`,
  },
  {
    id: "analyst-contrarian", codename: "CONTRARIAN", layer: "analyst", sortOrder: 14,
    title: "Devil's Advocate",
    job: "Credited on plus-money and underdog plays, the spots where being contrarian is the whole point.",
    prompt: `You are CONTRARIAN. Challenge each candidate: is the price already fair? Is the favourite steep enough that one loss erases several wins? Veto bad prices and public traps, but only with a concrete reason from the supplied data.`,
  },
  // ---------------- COUNCIL (Layer 3) ----------------
  {
    id: "council-historian", codename: "HISTORIAN", layer: "council", sortOrder: 15,
    title: "Track-Record Gatekeeper",
    job: "Tests every market bucket against its own recent results and throttles or pauses the ones that are clearly cold. Credited on picks from buckets with a measured record.",
    prompt: `HISTORIAN — statistical track-record gating.
For each bucket (e.g. nba:spread, mma:fight_rounds) it compares recent wins with what the prices taken would break even at (a z-test). Under 20 graded bets: no judgement. Clearly cold (z ≤ -1.3): half stakes and a higher bar. Very cold with 30+ bets (z ≤ -2.0): paused until old results age out.
This replaces the old loop that rewrote prompts after 8 bets — 8 bets is noise, and rewriting prompts changed nothing for the deterministic scouts.`,
  },
  {
    id: "council-commissioner", codename: "COMMISSIONER", layer: "council", sortOrder: 16,
    title: "Card Authority",
    job: "Releases only candidates that clear the bar — never pads the card. Its record is the card's record.",
    prompt: `COMMISSIONER — card assembly.
Releases a candidate only if its expected value clears the bar at a price you can actually get (or, for model-priced picks, its probability clears the floor). Limits correlated bets: one side per game, one duration bet per fight. An empty card is a valid and often profitable answer.`,
  },
  {
    id: "council-risk", codename: "RISK", layer: "council", sortOrder: 17,
    title: "Bankroll & Risk Manager",
    job: "Sizes every bet with fractional Kelly and enforces per-bet, per-game and daily caps. Credited on bets whose stake it reduced.",
    prompt: `RISK — unit management.
Stake = quarter-Kelly on the estimated win probability and the real price, haircut for how much the number is trusted (model-priced = less), rounded DOWN to quarter units. 1 unit = 1% of a 100-unit bankroll.
Caps: 2u per posted-line bet, 1u per model-priced bet, 2u per game, and a daily limit set by discipline (Strict 5u / Standard 8u / Loose 12u).`,
  },
];

export const DEFAULT_AGENT_ORDER = AGENT_DEFS.map((d) => d.id);
const DEF_BY_ID = new Map(AGENT_DEFS.map((d) => [d.id, d]));

/** Every workspace gets its own private copy of the roster. */
export async function ensureAgentsSeeded(ownerId: string = HOUSE): Promise<void> {
  await ensureSchema();
  const rows = await db.select().from(agents).where(eq(agents.ownerId, ownerId));
  const have = new Set(rows.map((r) => r.agentKey));
  const stale = rows.filter((r) => !DEF_BY_ID.has(r.agentKey));
  const outdated = rows.filter((r) => DEF_BY_ID.has(r.agentKey) && r.promptVersion < PROMPT_VERSION);
  if (have.size >= AGENT_DEFS.length && !stale.length && !outdated.length) return;

  for (const def of AGENT_DEFS) {
    if (have.has(def.id)) continue;
    await db
      .insert(agents)
      .values({
        id: ownerId === HOUSE ? def.id : `${ownerId}:${def.id}`,
        ownerId,
        agentKey: def.id,
        codename: def.codename,
        layer: def.layer,
        sortOrder: def.sortOrder,
        title: def.title,
        job: def.job,
        prompt: def.prompt,
        model: "heuristic-core",
        rating: 1500,
        promptVersion: PROMPT_VERSION,
      })
      .onConflictDoNothing();
  }

  // Upgrade playbooks from an older version. The previous prompt and record are
  // archived in the agent's log; counters restart because the engine changed and
  // the old record measured something else (every agent shared the card's results).
  for (const row of outdated) {
    const def = DEF_BY_ID.get(row.agentKey)!;
    const total = row.wins + row.losses;
    const entry: ImprovementEntry = {
      at: new Date().toISOString(),
      reason: `Playbook upgraded to v${PROMPT_VERSION}`,
      detail: `Archived v${row.promptVersion} record ${row.wins}W–${row.losses}L${row.pushes ? `–${row.pushes}P` : ""} (${total} graded, rating ${row.rating.toFixed(0)}). Previous prompt: ${row.prompt.replace(/\s+/g, " ").slice(0, 400)}`,
      ratingBefore: row.rating,
      ratingAfter: 1500,
    };
    await db
      .update(agents)
      .set({
        prompt: def.prompt,
        job: def.job,
        title: def.title,
        codename: def.codename,
        layer: def.layer,
        sortOrder: def.sortOrder,
        rating: 1500,
        wins: 0,
        losses: 0,
        pushes: 0,
        improvements: [...(row.improvements ?? []), entry].slice(-12),
        promptVersion: PROMPT_VERSION,
        updatedAt: new Date(),
      })
      // conditional, so two concurrent requests can't both archive
      .where(and(eq(agents.id, row.id), lt(agents.promptVersion, PROMPT_VERSION)));
  }

  // Remove agents that no longer exist (e.g. the retired MATCHUP scout).
  if (stale.length) {
    await db.delete(agents).where(
      and(
        eq(agents.ownerId, ownerId),
        inArray(
          agents.id,
          stale.map((r) => r.id),
        ),
      ),
    );
  }
}

export async function listAgents(ownerId: string = HOUSE): Promise<AgentRow[]> {
  await ensureAgentsSeeded(ownerId);
  return db
    .select()
    .from(agents)
    .where(eq(agents.ownerId, ownerId))
    .orderBy(agents.sortOrder);
}

export function tierOf(rating: number): { name: string; tone: string } {
  if (rating >= 1650) return { name: "GRANDMASTER", tone: "magenta" };
  if (rating >= 1580) return { name: "ELITE SHARP", tone: "cyan" };
  if (rating >= 1540) return { name: "PRO", tone: "green" };
  if (rating >= 1490) return { name: "JOURNEYMAN", tone: "slate" };
  if (rating >= 1440) return { name: "ROOKIE", tone: "amber" };
  return { name: "ON TRIAL", tone: "red" };
}

// ---------- rating settlement ----------

const K = 28;

export interface GradedForRating {
  agents: string[];
  outcome: string;
  /** estimated win probability 0..1 when known (v5+) */
  modelProb: number | null;
  /** legacy score, used only when modelProb is missing */
  confidence: number;
}

/**
 * Elo-style rating from graded picks. The expectation is the pick's own
 * estimated win probability, so an agent that wins exactly as often as it claims
 * stays flat; only over- or under-performance moves it. Voids are ignored.
 * (The old "self-improvement" rewrite is gone — see health.ts.)
 */
export async function settleAgentRatings(graded: GradedForRating[]): Promise<void> {
  const usable = graded.filter((g) => g.outcome === "win" || g.outcome === "loss" || g.outcome === "push");
  if (!usable.length) return;

  // Always settle against the HOUSE roster for global reputation
  const rows = await db.select().from(agents).where(eq(agents.ownerId, HOUSE));
  const byCode = new Map(rows.map((r) => [r.codename, r]));
  for (const r of rows) {
    if (r.codename.endsWith("_EXPERT")) {
      const sport = r.codename.replace("_EXPERT", "");
      byCode.set(`EXPERT_${sport}`, r); // old signal format
    }
  }
  const byId = new Map(rows.map((r) => [r.agentKey || r.id, r]));
  const touched = new Map<string, (typeof rows)[number]>();

  for (const g of usable) {
    const result = g.outcome === "win" ? 1 : g.outcome === "push" ? 0.5 : 0;
    const p = g.modelProb ?? g.confidence / 100;
    const expected = Math.min(0.85, Math.max(0.3, p));
    for (const who of new Set(g.agents)) {
      const row = byCode.get(who) ?? byId.get(who);
      if (!row) continue;
      const cur = touched.get(row.id) ?? { ...row };
      cur.rating = cur.rating + K * (result - expected) * 0.28;
      if (result === 1) cur.wins += 1;
      else if (result === 0.5) cur.pushes += 1;
      else cur.losses += 1;
      touched.set(row.id, cur);
    }
  }

  for (const row of touched.values()) {
    row.rating = Math.round(Math.min(1780, Math.max(1290, row.rating)) * 10) / 10;
    await db
      .update(agents)
      .set({
        rating: row.rating,
        wins: row.wins,
        losses: row.losses,
        pushes: row.pushes,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, row.id));
  }
}

/**
 * Operator action: restore an agent to the built-in playbook. Safe and
 * reversible — the prompt being replaced is archived in the agent's log.
 * Replaces the old "force improve", which let an LLM rewrite prompts freely.
 */
export async function resetAgentPlaybook(row: AgentRow, reason = "Operator reset to built-in playbook"): Promise<boolean> {
  const def = DEF_BY_ID.get(row.agentKey);
  if (!def) return false;
  const entry: ImprovementEntry = {
    at: new Date().toISOString(),
    reason,
    detail: `Restored the v${PROMPT_VERSION} built-in playbook. Replaced: ${row.prompt.replace(/\s+/g, " ").slice(0, 400)}`,
    ratingBefore: row.rating,
    ratingAfter: row.rating,
  };
  await db
    .update(agents)
    .set({
      prompt: def.prompt,
      improvements: [...(row.improvements ?? []), entry].slice(-12),
      updatedAt: new Date(),
    })
    .where(eq(agents.id, row.id));
  return true;
}
