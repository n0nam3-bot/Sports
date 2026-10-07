import { db } from "@/db";
import { agents, type AgentRow, type ImprovementEntry } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { targetFor } from "./llm";
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
  { id: "expert-nfl", codename: "NFL_EXPERT", layer: "scout", sortOrder: 6, title: "NFL Tactical Scout", job: "Analyzes defense coverage vs offense plays, pass/rush heavy tendencies, trenches/secondary injuries, and weather.", prompt: "You are the NFL_EXPERT. Analyze defensive schemes vs offensive play calling, run/pass splits, weather impact, and positional mismatches. State who the matchup favors." },
  { id: "expert-nba", codename: "NBA_EXPERT", layer: "scout", sortOrder: 7, title: "NBA Tactical Scout", job: "Analyzes pace, matchup advantages in the paint vs perimeter, and rotation changes.", prompt: "You are the NBA_EXPERT. Analyze pace, interior vs perimeter defense, and bench depth. State who the matchup favors." },
  { id: "expert-mlb", codename: "MLB_EXPERT", layer: "scout", sortOrder: 8, title: "MLB Tactical Scout", job: "Analyzes pitching matchups, bullpen depth, wOBA splits, and park factors.", prompt: "You are the MLB_EXPERT. Analyze starting pitching, bullpen usage, splits, and weather. State who the matchup favors." },
  { id: "expert-nhl", codename: "NHL_EXPERT", layer: "scout", sortOrder: 9, title: "NHL Tactical Scout", job: "Analyzes expected goals, goalie form, and special teams.", prompt: "You are the NHL_EXPERT. Analyze 5v5 metrics, power play vs penalty kill, and goaltending form. State who the matchup favors." },
  { id: "expert-mma", codename: "MMA_EXPERT", layer: "scout", sortOrder: 10, title: "MMA Tactical Scout", job: "Analyzes stances, striking vs grappling, submission threats, cardio, and pace.", prompt: "You are the MMA_EXPERT. Analyze fighting styles (striker vs grappler), finish dependency, gas tank over 3/5 rounds, and path to victory." },
  { id: "expert-ncaaf", codename: "NCAAF_EXPERT", layer: "scout", sortOrder: 11, title: "NCAAF Tactical Scout", job: "Analyzes talent disparity, trench mismatches, and scheme collisions.", prompt: "You are the NCAAF_EXPERT. Analyze air raid vs pro style, home-field advantage, and motivational spots. State who the matchup favors." },
  { id: "expert-ncaab", codename: "NCAAB_EXPERT", layer: "scout", sortOrder: 12, title: "NCAAB Tactical Scout", job: "Analyzes tempo, rebounding margins, and interior defense.", prompt: "You are the NCAAB_EXPERT. Analyze tempo, 3pt reliance, and interior size. State who the matchup favors." },
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
  const rows = await db.select().from(agents);
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

  const directive = buildDirective(row, rate);
  const entry: ImprovementEntry = {
    at: new Date().toISOString(),
    reason: `Strike rate ${(rate * 100).toFixed(1)}% after ${total} graded bets`,
    detail: directive,
    ratingBefore: row.rating,
    ratingAfter: row.rating + 18,
  };
  const newPrompt = `${row.prompt}\n\nSELF-CORRECTION LOG (${entry.at.slice(0, 10)}):\n${directive}`;
  await db
    .update(agents)
    .set({
      prompt: newPrompt.slice(0, 6000),
      rating: Math.min(1550, row.rating + 18), // reset bump after retraining
      wins: Math.floor(row.wins * 0.4),
      losses: Math.floor(row.losses * 0.4),
      pushes: Math.floor(row.pushes * 0.4),
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
