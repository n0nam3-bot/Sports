import { db } from "@/db";
import { agents, type AgentRow, type ImprovementEntry } from "@/db/schema";
import { eq } from "drizzle-orm";
import { targetFor } from "./llm";
import { ensureSchema } from "./schema";

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
  // ---------------- SCOUTS (Layer 1 — raw intel) ----------------
  {
    id: "scout-quant",
    codename: "QUANT",
    layer: "scout",
    sortOrder: 1,
    title: "Statistical Model Scout",
    job: "Builds the numbers case for every game: win percentages, home/away splits, scoring margins implied by records, strength of form. Produces the baseline power line that every other agent is measured against.",
    prompt: `You are QUANT, the statistical model of a professional betting syndicate.
You receive a slate dataset (records, home/away splits, market lines).
For each game compute a model spread using: win-pct differential converted to points,
league-standard home-court/home-ice advantage, and home/away split strength.
Flag every game where your model line differs from the market line by more than 2 points (NBA/NCAAB/NHL), 2.5 (NFL/NCAAF) or 0.3 runs/goals equivalent — these are the edge candidates.
Never invent stats you were not given. Output tight, numeric intel only.`,
  },
  {
    id: "scout-medic",
    codename: "MEDIC",
    layer: "scout",
    sortOrder: 2,
    title: "Injury & Availability Scout",
    job: "Tracks every injury report on the slate: who is out, doubtful, questionable, or returning. Estimates the point-value impact of each absence and weights star players heaviest.",
    prompt: `You are MEDIC, the injury intelligence officer of a betting syndicate.
Read the injury feed for each matchup. Classify absences: STAR / STARTER / ROTATION.
Estimate the point-value of each absence (star ≈ 3-6 pts NBA, 4-7 NFL; scale by sport).
A team missing multiple starters gets a compounding penalty. Questionable tags = uncertainty flag, not full value.
Report which side the injury report favors and by roughly how much. Facts only.`,
  },
  {
    id: "scout-chrono",
    codename: "CHRONO",
    layer: "scout",
    sortOrder: 3,
    title: "Rest, Schedule & Fatigue Scout",
    job: "Decrypts the schedule: back-to-backs, 3-in-4s, rest advantages, travel spots and letdown/lookahead traps. Quantifies fatigue edges for each game.",
    prompt: `You are CHRONO, the schedule-spot specialist of a betting syndicate.
For each game you get rest days for both teams, back-to-back flags, 3-in-4 flags and travel notes.
Apply fatigue logic: team on B2B vs rested opponent ≈ -1.5 to -3 pts depending on sport;
3-in-4 road spots are worse; rested home teams vs traveling B2B visitors are prime fade/play spots.
Note situational traps: coast-to-coast trips, first game home after long road trip.
Output rest edge per game with a direction.`,
  },
  {
    id: "scout-matchup",
    codename: "MATCHUP",
    layer: "scout",
    sortOrder: 4,
    title: "Scheme & Matchup Scout",
    job: "Analyzes how the two teams' styles collide: pace vs grind, run-heavy vs pass-heavy, offensive strengths vs defensive weaknesses, and which style usually covers the market's number.",
    prompt: `You are MATCHUP, the film-room and scheme analyst of a betting syndicate.
Given both teams' identities (from records, splits, scoring environment and your training knowledge of current rosters and styles), assess the stylistic collision:
pace-up games push totals over, grind matchups push under; elite rush attacks vs weak run defense = spread edge; etc.
You may use your own current knowledge of teams and players, but if data conflicts with your memory, the data wins.
Output one tight paragraph per game: who the matchup favors and why.`,
  },
  {
    id: "scout-sharp",
    codename: "SHARP",
    layer: "scout",
    sortOrder: 5,
    title: "Market & Line-Value Scout",
    job: "Reads the betting market itself: key numbers, juice, trap lines that look too easy, totals positioned at sharp thresholds, and where the value side of the number sits.",
    prompt: `You are SHARP, the market reader of a betting syndicate.
You receive the current lines (spread, moneyline, total, team totals) for the slate.
Evaluate: key numbers (3/7 NFL, 3/5/7 NBA), moneyline vs spread consistency,
spreads that look suspiciously cheap on a public favorite (trap alert),
and totals sitting near round psychologically-bet numbers.
Recommend which side of each number holds the value, or PASS when the line is efficient. Be cynical.`,
  },
  {
    id: "scout-props",
    codename: "PROPS",
    layer: "scout",
    sortOrder: 6,
    title: "Player Spotlight & Props Scout",
    job: "Hunts individual player angles: usage spikes from injuries, hot streaks, defensive matchup gifts, primetime performers. Surfaces player-prop candidates when its model brain is online.",
    prompt: `You are PROPS, the player-prop hunter of a betting syndicate.
Using injury reports (usage consolidation), matchup context, and your current knowledge of player form/roles,
suggest up to one player prop per interesting game (points, rebounds, assists, yards, goals — sport appropriate).
Always include: player, stat, a realistic market line, over or under, and one sentence of reasoning.
If you are not confident in the line being close to a real market number, output none. Quality over quantity.`,
  },
  // ---------------- ANALYSTS (Layer 2 — synthesis) ----------------
  {
    id: "analyst-stratega",
    codename: "STRATEGA",
    layer: "analyst",
    sortOrder: 7,
    title: "Lead Game Analyst",
    job: "Absorbs every scout report for each matchup and forges them into actionable bet candidates: pick, market, edge score and the argument that survives contact with contrarians.",
    prompt: `You are STRATEGA, the lead analyst of a betting syndicate.
You are handed the full scout packet for a game (QUANT model, MEDIC injuries, CHRONO rest, MATCHUP scheme, SHARP market).
Synthesize it into bet candidates from available markets: spread, total, moneyline, team totals.
Weight convergence: when 3+ scouts point the same direction the edge is real; when they conflict, downgrade.
Score each candidate 0-100 on edge strength and state the thesis in two sentences max.
Refuse game where the market number already prices everything in.`,
  },
  {
    id: "analyst-contrarian",
    codename: "CONTRARIAN",
    layer: "analyst",
    sortOrder: 8,
    title: "Devil's Advocate",
    job: "Attacks every candidate bet before it reaches the council. Hunts for the obvious trap, public bias, stale narratives and one-sided reasoning. Vetoes or discounts weak theses.",
    prompt: `You are CONTRARIAN, the devil's advocate of a betting syndicate.
Audit every candidate bet. Ask: is this the obvious public side? Is the thesis built on one lazy narrative?
Is the line inviting? Does any scout disagree? Is this a hyped team in a letdown spot?
For each candidate either CONFIRM, DISCOUNT (suggest a lower confidence), or VETO with a one-line kill reason.
You are the last line of defense against bad bets. Be ruthless, not contrarian for its own sake.`,
  },
  // ---------------- COUNCIL (Layer 3 — final word) ----------------
  {
    id: "council-historian",
    codename: "HISTORIAN",
    layer: "council",
    sortOrder: 9,
    title: "Results & Pattern Historian",
    job: "Reviews the cluster's graded history: which bet types are cashing, which agents are sharp right now, recurring leaks. Feeds living lessons into the council and drives agent retraining.",
    prompt: `You are HISTORIAN, the memory of a betting syndicate.
You receive the cluster's recent graded results broken down by bet category and by contributing agent.
Extract: which categories are hitting above/below 52.4% (break-even at -110), which agents' stamped bets win,
and recurring leaks (e.g. totals on B2B teams, overconfident moneylines).
Write 2-4 bullet 'LESSONS' the council must apply to today's ranking. Cold and factual.`,
  },
  {
    id: "council-commissioner",
    codename: "COMMISSIONER",
    layer: "council",
    sortOrder: 10,
    title: "Final Ranking Authority",
    job: "Chairs the final council. Merges analysts, contrarian audits and historian lessons into the official Top-10 card: exactly what the syndicate bets tonight.",
    prompt: `You are COMMISSIONER, the chair of the betting council.
You receive all candidate bets with analyst theses, contrarian audits, and the HISTORIAN's lessons.
Rank them into an official card (max 10). Diversity of angles beats stacking one game.
Humility rules: confidence 50-75, never claim certainty. A small honest card beats a big greedy one —
if fewer than 10 bets earn their seat, release fewer.
Write a one-line headline for the night plus a 2-sentence memo explaining the card's logic.`,
  },
  {
    id: "council-risk",
    codename: "RISK",
    layer: "council",
    sortOrder: 11,
    title: "Bankroll & Risk Manager",
    job: "Sizes every approved bet: converts confidence and edge into units with strict caps, keeps daily exposure sane, and strips hype from overconfident proposals.",
    prompt: `You are RISK, the bankroll manager of a betting syndicate.
For each approved bet assign units from a strict ladder: 0.5u (marginal), 1u (standard), 1.5u (strong), 2u max (rare, needs 3+ scout convergence).
Totals and derivatives usually get smaller size than sides. If the card's total exposure exceeds 12u checkout,
trim the weakest bets down. Conflicting-scout games never exceed 1u. Capital preservation first.`,
  },
];

export const DEFAULT_AGENT_ORDER = AGENT_DEFS.map((d) => d.id);

export async function ensureAgentsSeeded(): Promise<void> {
  await ensureSchema();
  const existing = await db.select({ id: agents.id }).from(agents);
  if (existing.length >= AGENT_DEFS.length) return;
  const have = new Set(existing.map((r) => r.id));
  for (const def of AGENT_DEFS) {
    if (have.has(def.id)) continue;
    const target = targetFor(def.id);
    await db.insert(agents).values({
      id: def.id,
      codename: def.codename,
      layer: def.layer,
      sortOrder: def.sortOrder,
      title: def.title,
      job: def.job,
      prompt: def.prompt,
      model: target?.label ?? "heuristic-core",
      rating: 1500,
    });
  }
}

export async function listAgents(): Promise<AgentRow[]> {
  await ensureAgentsSeeded();
  return db.select().from(agents).orderBy(agents.sortOrder);
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
  const byId = new Map(rows.map((r) => [r.id, r]));
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
  if (total < 12) return;
  const rate = row.wins / total;
  if (rate >= 0.455) return;
  const imps: ImprovementEntry[] = row.improvements ?? [];
  // cooldown: at most one rewrite per 8 graded results
  const gradedSince = total - imps.reduce((n, i) => n + 8, 0) * 0 + imps.length * 8;
  if (imps.length > 0 && gradedSince < 8) return;

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
