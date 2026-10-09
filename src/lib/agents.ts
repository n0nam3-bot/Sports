import { db } from "@/db";
import { agents, type AgentRow, type ImprovementEntry } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { configuredProviders, llmChat, targetFor, type KeyBag } from "./llm";
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

export const AGENT_DEFS: AgentDef[] = [
  // ---------------- SCOUTS (Layer 1) ----------------
  { id: "scout-quant", codename: "QUANT", layer: "scout", sortOrder: 1, title: "Statistical Model Scout", job: "Builds the numbers case for every game: win percentages, scoring margins, strength of form.", prompt: "You are QUANT. Output tight, numeric intel only." },
  { id: "scout-medic", codename: "MEDIC", layer: "scout", sortOrder: 2, title: "Injury & Availability Scout", job: "Tracks every injury report and depth chart impact.", prompt: "You are MEDIC. Report which side the injury report favors and by how much." },
  { id: "scout-chrono", codename: "CHRONO", layer: "scout", sortOrder: 3, title: "Rest & Schedule Scout", job: "Decrypts schedule fatigue.", prompt: "You are CHRONO. Output rest edge per game with a direction." },
  { id: "scout-sharp", codename: "SHARP", layer: "scout", sortOrder: 4, title: "Market & Line-Value Scout", job: "Reads the betting market itself.", prompt: "You are SHARP. Recommend which side of each number holds the value." },
  { id: "scout-props", codename: "PROPS", layer: "scout", sortOrder: 5, title: "Player Spotlight & Props Scout", job: "Hunts individual player angles.", prompt: "You are PROPS. Quality over quantity." },
  // Sport Specialists
  { id: "expert-nfl", codename: "NFL_EXPERT", layer: "scout", sortOrder: 6, title: "NFL Tactical Scout", job: "Analyzes defensive coverage (2-high vs single-high), trench injuries, QB-receiver chemistry vs specific secondaries, and weather/field condition impact.", prompt: "You are the NFL_EXPERT. Analyze defensive coverage types vs offensive playbooks, pass/rush heavy splits, trench mismatches, and weather impact. Focus on who benefits from specific defensive injuries. State which side and market (Spread/Total/Prop) holds the tactical edge." },
  { id: "expert-nba", codename: "NBA_EXPERT", layer: "scout", sortOrder: 7, title: "NBA Tactical Scout", job: "Analyzes pace-up/down spots, perimeter vs interior defensive efficiency, and bench-usage spikes due to starters' load management.", prompt: "You are the NBA_EXPERT. Analyze pace, defensive efficiency by zone, and rotation changes. Identify 'usage traps' where a missing starter's points won't be replaced 1:1. State the tactical edge." },
  { id: "expert-mlb", codename: "MLB_EXPERT", layer: "scout", sortOrder: 8, title: "MLB Tactical Scout", job: "Analyzes starter K/BB rates vs batting splits, bullpen usage over the last 3 days, and park factors (humidity/wind) affecting run expectancy.", prompt: "You are the MLB_EXPERT. Analyze pitcher velocity/form, bullpen fatigue, and lefty/righty splits. Focus on how weather (wind/temp) moves the run-expectancy baseline. State the tactical edge." },
  { id: "expert-nhl", codename: "NHL_EXPERT", layer: "scout", sortOrder: 9, title: "NHL Tactical Scout", job: "Analyzes expected goals (xG), high-danger chances allowed, goalie SV% on unblocked shots, and special teams (PP/PK) volatility.", prompt: "You are the NHL_EXPERT. Analyze high-danger scoring chances, goaltending form, and special team matchups. State the tactical edge." },
  { id: "expert-mma", codename: "MMA_EXPERT", layer: "scout", sortOrder: 10, title: "MMA Tactical Scout", job: "Analyzes southpaw vs orthodox counters, striking output vs grappling control, finish tendencies in round 1 vs 2, and gas tank durability over 3/5 rounds.", prompt: "You are the MMA_EXPERT. Analyze stance matchups, sub threats, and striking-accuracy gaps. Evaluate cardio/pace sustainability over 3 or 5 rounds. Focus on finish probability vs decision likelihood. State the tactical edge." },
  { id: "expert-ncaaf", codename: "NCAAF_EXPERT", layer: "scout", sortOrder: 11, title: "NCAAF Tactical Scout", job: "Analyzes recruiting talent gaps, transfer-portal impact on cohesion, and specific situational spots (revenge/lookahead).", prompt: "You are the NCAAF_EXPERT. Analyze talent disparity, scheme cohesion, and situational motivation. Focus on trench mismatches. State the tactical edge." },
  { id: "expert-ncaab", codename: "NCAAB_EXPERT", layer: "scout", sortOrder: 12, title: "NCAAB Tactical Scout", job: "Analyzes defensive pressure types (press vs zone), 3pt reliance/variance, and rebounding margins at home vs away.", prompt: "You are the NCAAB_EXPERT. Analyze tempo, 3pt variance, and rebounding differentials. State the tactical edge." },
  // ---------------- ANALYSTS (Layer 2) ----------------
  { id: "analyst-stratega", codename: "STRATEGA", layer: "analyst", sortOrder: 13, title: "Lead Game Analyst", job: "Synthesizes scouts into release-grade candidates.", prompt: "You are STRATEGA. Weight convergence: 3+ scouts pointing the same direction = real edge." },
  { id: "analyst-contrarian", codename: "CONTRARIAN", layer: "analyst", sortOrder: 14, title: "Devil's Advocate", job: "Attacks every candidate bet before the council.", prompt: "You are CONTRARIAN. Audit every candidate bet. VETO bad prices or public traps." },
  // ---------------- COUNCIL (Layer 3) ----------------
  { id: "council-historian", codename: "HISTORIAN", layer: "council", sortOrder: 15, title: "Results & Pattern Historian", job: "Reviews graded history.", prompt: "You are HISTORIAN. Extract lessons from recent graded results." },
  { id: "council-commissioner", codename: "COMMISSIONER", layer: "council", sortOrder: 16, title: "Final Ranking Authority", job: "Chairs the final council.", prompt: "You are COMMISSIONER. Rank into an official card." },
  { id: "council-risk", codename: "RISK", layer: "council", sortOrder: 17, title: "Bankroll & Risk Manager", job: "Sizes every approved bet.", prompt: "You are RISK. Assign units from a strict ladder." },
];

export const DEFAULT_AGENT_ORDER = AGENT_DEFS.map((d) => d.id);

/** Every workspace gets its own private copy of the roster. */
export async function ensureAgentsSeeded(ownerId: string = HOUSE): Promise<void> {
  await ensureSchema();
  const existing = await db
    .select({ agentKey: agents.agentKey })
    .from(agents)
    .where(eq(agents.ownerId, ownerId));
  if (existing.length >= AGENT_DEFS.length) return;
  const have = new Set(existing.map((r) => r.agentKey));
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
      })
      .onConflictDoNothing();
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

// ---------- rating settlement + self improvement ----------

const K = 28;

export async function settleAgentRatings(
  graded: { agents: string[]; outcome: string; confidence: number }[],
): Promise<void> {
  if (!graded.length) return;
  // Always settle against the HOUSE roster for global reputation
  const rows = await db.select().from(agents).where(eq(agents.ownerId, HOUSE));
  const byCode = new Map(rows.map((r) => [r.codename, r]));
  // Also map old-format EXPERT_X signals to the correct agent
  for (const r of rows) {
    if (r.codename.endsWith("_EXPERT")) {
      const sport = r.codename.replace("_EXPERT", "");
      byCode.set(`EXPERT_${sport}`, r); // old format compatibility
    }
  }
  const byId = new Map(rows.map((r) => [r.agentKey || r.id, r]));
  const touched = new Map<string, typeof rows[number]>();

  for (const g of graded) {
    const result = g.outcome === "win" ? 1 : g.outcome === "push" ? 0.5 : 0;
    const expected = Math.min(0.85, Math.max(0.3, g.confidence / 100));
    for (const who of g.agents) {
      const row = byCode.get(who) ?? byId.get(who);
      if (!row) continue;
      const cur = touched.get(row.id) ?? { ...row };
      cur.rating = cur.rating + K * (result - expected) * 0.28; // shared credit/blame
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
    await maybeSelfImprove(row);
  }
}

// An agent whose recent strike rate collapses rewrites its own playbook.
async function maybeSelfImprove(row: (typeof agents.$inferSelect)): Promise<void> {
  const total = row.wins + row.losses;
  if (total < 8) return;  // need at least 8 graded to have signal
  const rate = row.wins / total;
  if (rate >= 0.50) return;  // fire whenever below break-even
  const imps: ImprovementEntry[] = row.improvements ?? [];
  // cooldown: at most one rewrite per 6 graded results
  if (imps.length > 0 && total - (imps.length * 6) < 6) return;

  const reason = `Strike rate ${(rate * 100).toFixed(1)}% after ${total} graded bets`;
  await rewriteAgentPlaybook(row, reason);
}

/**
 * Genuinely rewrites an agent's prompt based on its performance data.
 * If LLMs are available, it uses them to synthesize a new playbook.
 * If not, it falls back to the static directive.
 */
export async function rewriteAgentPlaybook(
  row: typeof agents.$inferSelect,
  reason: string,
  keys: KeyBag = {}
): Promise<void> {
  const total = row.wins + row.losses;
  const rate = total > 0 ? row.wins / total : 0.5;
  const directive = buildDirective(row, rate);
  
  // Try to use a "Meta-Analyst" LLM to rewrite the prompt.
  // We prefer the provider assigned to this agent if possible.
  const target = targetFor(row.agentKey, keys, true) || configuredProviders(keys)[0];
  let finalPrompt = `${row.prompt}\n\nSELF-CORRECTION LOG (${new Date().toISOString().slice(0,10)}):\n${directive}`;
  let improvementDetail = `Static directive fallback: ${directive}`;

  if (target) {
    const metaPrompt = `You are the NEONSLIP Meta-Analyst.
An AI Betting Agent ("${row.codename}") has underperformed with a win rate of ${(rate * 100).toFixed(1)}%.
Its Job: ${row.job}
Its Current Playbook:
---
${row.prompt}
---
The Lead Analyst's Feedback: ${directive}

Task: Rewrite the Agent's Playbook prompt to be more accurate and avoid past mistakes. 
Incorporate the specific tactical feedback. Keep it professional and technical.
Output ONLY the new prompt text. Do not include any meta-commentary.`;

    const rewrite = await llmChat(target, "You rewrite AI prompts for better sports betting accuracy.", metaPrompt, { timeoutMs: 25000 });
    if (rewrite && rewrite.length > 50) {
      finalPrompt = rewrite.slice(0, 6000);
      improvementDetail = `Genuinely rewritten by ${target.label} to address: ${directive}`;
    }
  }

  const imps: ImprovementEntry[] = row.improvements ?? [];
  const entry: ImprovementEntry = {
    at: new Date().toISOString(),
    reason,
    detail: improvementDetail,
    ratingBefore: row.rating,
    ratingAfter: row.rating, // we don't necessarily bump rating on rewrite anymore, let it earn it
  };

  await db
    .update(agents)
    .set({
      prompt: finalPrompt,
      // reset partial stats so it starts fresh with the new prompt
      wins: Math.floor(row.wins * 0.3),
      losses: Math.floor(row.losses * 0.3),
      pushes: Math.floor(row.pushes * 0.3),
      improvements: [...imps, entry].slice(-12),
      updatedAt: new Date(),
    })
    .where(eq(agents.id, row.id));
}

function buildDirective(row: typeof agents.$inferSelect, rate: number): string {
  const base: Record<string, string> = {
    "scout-quant":
      "Your model line has been systematically off. Re-anchor to market efficiency: require a larger model-vs-market gap (raise edge thresholds by 1.5 points) before flagging value, and cap how far home advantage can move your line.",
    "scout-medic":
      "You have been overvaluing raw injury counts and missing which absences actually move lines. Weight confirmed OUT stars 2x, stop pricing QUESTIONABLE tags as real absences, and discount injuries the market suspended books have already baked in.",
    "scout-chrono":
      "Rest angles have underperformed. Reduce B2B penalty by ~30% for elite/home teams, upgrade the penalty only for road B2B with travel, and stop fading rested teams in revenge or trap spots.",
    "scout-matchup":
      "Style reads have been narratively driven. Demand one concrete data point (splits, market number, injury context) supporting every scheme claim, and drop any matchup thesis that contradicts QUANT by more than 4 points.",
    "scout-sharp":
      "Your trap calls have faded steam that kept cashing. Only flag a trap when you can name the key-number or juice evidence; otherwise defer to market price. Tighten PASS frequency upward.",
    "scout-props":
      "Prop suggestions have missed on line accuracy. Only recommend props where usage consolidation from a confirmed absence is 15%+, set lines closer to player season medians, and prefer overs on expanded roles over unders on stars.",
    "analyst-stratega":
      "Your syntheses have been too agreeable. Require convergence of 3+ independent scouts for any candidate above 62 confidence, and hard-veto candidates where QUANT and SHARP actively disagree.",
    "analyst-contrarian":
      "Your vetoes have killed winners and passed losers. Re-calibrate: only veto when the candidate is a public-side favorite AND there is a specific spot/injury counter-narrative; otherwise use DISCOUNT.",
    "council-historian":
      "Your lessons over-fit small samples. Require a minimum 10-bet sample before declaring a leak, weight recent form of each agent more than lifetime stats, and stop repeating stale lessons older than 30 days.",
    "council-commissioner":
      "The card has been too chalky. Cap favorites of -7+ on the card, require at least one total or underdog angle when available, and never release a card where average confidence exceeds 72.",
    "council-risk":
      "Sizing has been too aggressive on correlated angles. Enforce the 12u daily cap, cut any bet to 0.5u when two plays share the same game, and auto-downgrade totals by half a unit.",
  };
  return (
    base[row.id] ??
    `Strike rate ${(rate * 100).toFixed(0)}% is below professional standard. Narrow your scope to your highest-conviction signals only and demand corroboration from at least one other data source before asserting an edge.`
  );
}
