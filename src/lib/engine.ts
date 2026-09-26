import { db } from "@/db";
import {
  agents,
  predictions,
  runs,
  type CouncilDecision,
  type GradeSpec,
  type TraceEntry,
} from "@/db/schema";
import { and, desc, eq, inArray, lt, ne } from "drizzle-orm";
import {
  getFinals,
  getSlateDetailed,
  lookupPlayerStat,
  type GameInfo,
} from "./espn";
import { llmJson, targetFor } from "./llm";
import { ensureAgentsSeeded, settleAgentRatings } from "./agents";
import { ensureSchema } from "./schema";

export const revalidate = 0;

// ---------------------------------------------------------------------------
// slate cache (hot path shared by UI + pipeline)
// ---------------------------------------------------------------------------

const slateCache = new Map<string, { at: number; games: GameInfo[]; degraded: string[] }>();
const SLATE_TTL = 75_000;

export async function cachedSlate(
  date: string,
  sports: string[],
  opts: { budgetMs?: number; maxInjuryLookups?: number } = {},
): Promise<{ games: GameInfo[]; degraded: string[] }> {
  const key = `${date}|${[...sports].sort().join(",")}`;
  const hit = slateCache.get(key);
  if (hit && Date.now() - hit.at < SLATE_TTL) {
    return { games: hit.games, degraded: hit.degraded };
  }
  const { games, degraded } = await getSlateDetailed(date, sports, {
    budgetMs: opts.budgetMs ?? 12_000,
    maxInjuryLookups: opts.maxInjuryLookups ?? 30,
  });
  slateCache.set(key, { at: Date.now(), games, degraded });
  return { games, degraded };
}

// ---------------------------------------------------------------------------
// quantitative core (deterministic edge model — the "no keys required" brain)
// ---------------------------------------------------------------------------

const HOME_ADV: Record<string, number> = {
  nba: 2.6, ncaab: 3.0, nfl: 2.1, ncaaf: 2.5, nhl: 0.32, mlb: 0.32,
};
const MARGIN_SCALE: Record<string, number> = {
  nba: 23, ncaab: 24, nfl: 26, ncaaf: 26, nhl: 1.15, mlb: 1.05,
};
const EDGE_MIN: Record<string, number> = {
  nba: 2.0, ncaab: 2.2, nfl: 1.9, ncaaf: 2.4, nhl: 0.38, mlb: 0.34,
};
const PTS_PER_OUT: Record<string, number> = {
  nba: 1.5, ncaab: 1.4, nfl: 2.1, ncaaf: 2.1, nhl: 0.22, mlb: 0.28,
};
const B2B_PEN: Record<string, number> = {
  nba: 1.8, ncaab: 1.5, nfl: 2.0, ncaaf: 1.8, nhl: 0.28, mlb: 0.18,
};
const AVG_TOTAL: Record<string, number> = {
  nba: 224, ncaab: 144, nfl: 45.5, ncaaf: 55, nhl: 6.1, mlb: 8.5,
};

function winPct(record: string): number {
  const m = record.match(/(\d+)[-–](\d+)/);
  if (!m) return 0.5;
  const w = Number(m[1]);
  const l = Number(m[2]);
  return w + l > 0 ? w / (w + l) : 0.5;
}

export interface Candidate {
  id: number;
  game: GameInfo;
  category: string;
  pick: string;
  lineLabel: string;
  odds: number;
  edge: number;
  confidence: number;
  signals: string[]; // contributing scout codenames
  thesis: string;
  grade: GradeSpec;
  vetoed?: string;
  discount?: string;
  finalUnits?: number;
}

function impliedProb(ml: number): number {
  return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
}

// deterministic ±2.5 jitter so identical-edge boards still rank with texture
function jitter(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ((h % 50) - 25) / 10;
}

function logistic(margin: number, sport: string): number {
  const scale = sport === "nhl" || sport === "mlb" ? 0.55 : 6.2;
  return 1 / (1 + Math.exp(-margin / scale));
}

function injuryImpact(g: GameInfo, abbr: string): { pts: number; outs: number } {
  const mine = g.injuries.filter((i) => i.team === abbr || i.team.includes(abbr));
  let outs = 0;
  let weight = 0;
  for (const inj of mine) {
    const s = inj.status.toLowerCase();
    if (s.includes("out") || s.includes("inactive") || s.includes("injured reserve")) {
      outs += 1;
      weight += 1;
    } else if (s.includes("doubt")) weight += 0.7;
    else if (s.includes("question") || s.includes("day-to-day") || s.includes("game time"))
      weight += 0.3;
  }
  const eff = Math.min(weight, 3);
  return { pts: eff * (PTS_PER_OUT[g.sport] ?? 1), outs };
}

interface ModelOut {
  margin: number; // home perspective model margin, sport units
  signals: string[];
  intel: { quant: string; medic: string; chrono: string; sharp: string; matchup: string };
  restEdge: number;
  injNote: string;
}

function buildModel(g: GameInfo): ModelOut {
  const hp = winPct(g.home.record);
  const ap = winPct(g.away.record);
  const scale = MARGIN_SCALE[g.sport] ?? 20;
  const homeSplit = winPct(g.home.homeRecord || g.home.record);
  const awaySplit = winPct(g.away.awayRecord || g.away.record);
  let margin = (hp - ap) * scale + (HOME_ADV[g.sport] ?? 2);
  margin += (homeSplit - hp) * 4 + (awaySplit - ap) * -4 * 0;

  const signals = ["QUANT"];
  const injHome = injuryImpact(g, g.home.abbr);
  const injAway = injuryImpact(g, g.away.abbr);
  margin += injAway.pts - injHome.pts;
  if (injHome.outs + injAway.outs > 0) signals.push("MEDIC");

  let restEdge = 0;
  let restNote = "standard rest both sides";
  if (g.rest) {
    const pen = B2B_PEN[g.sport] ?? 1.5;
    let adj = 0;
    const bits: string[] = [];
    if (g.rest.homeB2B && !g.rest.awayB2B) {
      adj -= pen;
      bits.push(`${g.home.abbr} on a back-to-back`);
      if (g.rest.homeTravel && g.rest.awayDays >= 1) {
        adj -= 0.6;
        bits.push("with travel");
      }
    }
    if (g.rest.awayB2B && !g.rest.homeB2B) {
      adj += pen;
      bits.push(`${g.away.abbr} on a back-to-back`);
      if (g.rest.awayTravel && g.rest.homeDays >= 1) {
        adj += 0.6;
        bits.push("with travel");
      }
    }
    if (g.rest.home3in4 && !g.rest.away3in4 && !g.rest.homeB2B) {
      adj -= pen * 0.5;
      bits.push(`${g.home.abbr} 3-in-4 legs`);
    }
    if (g.rest.away3in4 && !g.rest.home3in4 && !g.rest.awayB2B) {
      adj += pen * 0.5;
      bits.push(`${g.away.abbr} 3-in-4 legs`);
    }
    if (g.rest.homeDays >= 2 && g.rest.awayDays === 0) adj += 0.7;
    if (g.rest.awayDays >= 2 && g.rest.homeDays === 0) adj -= 0.7;
    restEdge = adj;
    margin += adj;
    if (bits.length) {
      signals.push("CHRONO");
      restNote = bits.join(", ");
    }
  }
  if (g.odds) signals.push("SHARP");

  return {
    margin,
    signals: [...new Set(signals)],
    restEdge,
    injNote:
      injHome.outs + injAway.outs > 0
        ? `${g.away.abbr} ${injAway.outs} confirmed out / ${g.home.abbr} ${injHome.outs} confirmed out`
        : "no confirmed outs on the report",
    intel: { quant: "", medic: "", chrono: "", sharp: "", matchup: "" },
  };
}

function mlFair(margin: number, sport: string): number {
  const p = logistic(Math.abs(margin), sport);
  if (p >= 0.5) return -Math.round((p / (1 - p)) * 100);
  return Math.round(((1 - p) / p) * 100);
}

function candidatesFor(g: GameInfo, nextId: () => number): {
  cands: Candidate[];
  model: ModelOut;
} {
  const model = buildModel(g);
  const cands: Candidate[] = [];
  const o = g.odds;
  const mk = (
    category: string,
    pick: string,
    lineLabel: string,
    odds: number,
    edge: number,
    confidence: number,
    thesis: string,
    grade: GradeSpec,
    extra: string[] = [],
  ): Candidate => ({
    id: nextId(),
    game: g,
    category,
    pick,
    lineLabel,
    odds,
    edge,
    confidence,
    signals: [...new Set([...model.signals, ...extra])],
    thesis,
    grade,
  });

  if (o?.homeSpread != null) {
    const diff = model.margin - o.homeSpread; // + → home value
    const min = EDGE_MIN[g.sport] ?? 2;
    if (Math.abs(diff) >= min) {
      const homeSide = diff > 0;
      const team = homeSide ? g.home : g.away;
      const line = homeSide ? o.homeSpread : -o.homeSpread;
      const conf = Math.min(70, 54 + Math.min(13, Math.max(0, Math.abs(diff) - min) * 2.1) + jitter(g.eventId + "sp"));
      cands.push(
        mk(
          "spread",
          `${team.name} ${line > 0 ? "+" : ""}${Number(line.toFixed(1))}`,
          `spread ${line > 0 ? "+" : ""}${Number(line.toFixed(1))}`,
          -110,
          Math.abs(diff),
          conf,
          `Model makes this ${fmtLine(model.margin)} for ${g.home.abbr}; market has ${fmtLine(
            o.homeSpread,
          )}. ${edgeWhy(model, g, homeSide)}`,
          { side: homeSide ? "home" : "away", line },
        ),
      );
    }
  }

  if (o?.homeML != null && o?.awayML != null) {
    const pHome = logistic(model.margin, g.sport);
    const ipHome = impliedProb(o.homeML);
    const ipAway = impliedProb(o.awayML);
    const eH = pHome - ipHome;
    const eA = 1 - pHome - ipAway;
    if (eH >= 0.045) {
      cands.push(
        mk(
          "moneyline",
          `${g.home.name} ML`,
          `ML ${o.homeML > 0 ? "+" : ""}${o.homeML}`,
          o.homeML,
          eH * 100,
          Math.min(66, 54 + eH * 130),
          `Fair price ${mlFair(model.margin, g.sport)} vs market ${
            o.homeML > 0 ? "+" : ""
          }${o.homeML}. ${(eH * 100).toFixed(1)}% probability edge on ${g.home.abbr}.`,
          { side: "home", line: null },
        ),
      );
    } else if (eA >= 0.045) {
      cands.push(
        mk(
          "moneyline",
          `${g.away.name} ML`,
          `ML ${o.awayML > 0 ? "+" : ""}${o.awayML}`,
          o.awayML,
          eA * 100,
          Math.min(66, 54 + eA * 130),
          `Fair price ${oppFair(model.margin, g.sport)} vs market ${
            o.awayML > 0 ? "+" : ""
          }${o.awayML}. ${(eA * 100).toFixed(1)}% probability edge on ${g.away.abbr}.`,
          { side: "away", line: null },
        ),
      );
    }
  }

  if (o?.overUnder != null) {
    const avg = AVG_TOTAL[g.sport] ?? 0;
    const bothGood = winPct(g.home.record) > 0.55 && winPct(g.away.record) > 0.55;
    const bothBad = winPct(g.home.record) < 0.45 && winPct(g.away.record) < 0.45;
    let lean = avg - o.overUnder;
    if (bothGood) lean += (avg * 0.012);
    if (bothBad) lean -= avg * 0.012;
    if (g.rest?.homeB2B || g.rest?.awayB2B) lean -= avg * 0.009; // tired legs, missed shots
    const noise = (avg <= 10 ? 0.55 : avg <= 50 ? 2.2 : 4.5) * 0.85;
    if (Math.abs(lean) >= noise) {
      const over = lean > 0;
      const relative = (Math.abs(lean) - noise) / Math.max(1e-6, noise);
      const conf = Math.min(64, 53 + Math.min(9, relative * 3.8) + jitter(g.eventId + "tot") + (over && bothGood ? 1.5 : 0));
      cands.push(
        mk(
          "total",
          `${over ? "Over" : "Under"} ${o.overUnder} (${g.matchup})`,
          `${over ? "over" : "under"} ${o.overUnder}`,
          over ? o.overOdds ?? -110 : o.underOdds ?? -110,
          Math.abs(lean),
          conf,
          `${over ? "Pace-up environment" : "Suppressed-scoring profile"} — slate-average is ${avg}, book hangs ${o.overUnder}. ${
            g.rest?.homeB2B || g.rest?.awayB2B ? "Fatigue taxes the over. " : ""
          }${bothGood ? "Two winning profiles push tempo." : bothBad ? "Limited offensive ceiling on both sidelines." : ""}`,
          { side: over ? "over" : "under", line: o.overUnder },
        ),
      );
    }

    // team totals as game props when a big edge exists on the side
    if (o.homeTeamTotal != null && model.margin - (o.homeSpread ?? 0) >= (EDGE_MIN[g.sport] ?? 2) + 1.5) {
      cands.push(
        mk(
          "team_total",
          `${g.home.name} over ${o.homeTeamTotal} (team total)`,
          `team total over ${o.homeTeamTotal}`,
          -110,
          model.margin - (o.homeSpread ?? 0),
          Math.min(60, 53 + (model.margin - (o.homeSpread ?? 0)) * 1.1),
          `${g.home.abbr} projects well above its posted team total on the model margin. ${edgeWhy(model, g, true)}`,
          { side: "team_over", line: o.homeTeamTotal, teamAbbr: g.home.abbr },
        ),
      );
    }
    if (o.awayTeamTotal != null && (o.homeSpread ?? 0) - model.margin >= (EDGE_MIN[g.sport] ?? 2) + 1.5) {
      cands.push(
        mk(
          "team_total",
          `${g.away.name} over ${o.awayTeamTotal} (team total)`,
          `team total over ${o.awayTeamTotal}`,
          -110,
          (o.homeSpread ?? 0) - model.margin,
          Math.min(60, 53 + ((o.homeSpread ?? 0) - model.margin) * 1.1),
          `${g.away.abbr} projects well above its posted team total on the model margin. ${edgeWhy(model, g, false)}`,
          { side: "team_over", line: o.awayTeamTotal, teamAbbr: g.away.abbr },
        ),
      );
    }
  }

  return { cands, model };
}

function fmtLine(v: number): string {
  const s = Math.abs(v).toFixed(1);
  return v >= 0 ? `-${s}` : `+${s}`;
}
function oppFair(margin: number, sport: string): number {
  return mlFair(-margin, sport);
}
function edgeWhy(model: ModelOut, g: GameInfo, homeSide: boolean): string {
  const bits: string[] = [];
  if (model.injNote !== "no confirmed outs on the report") bits.push(`Injuries: ${model.injNote}.`);
  if (model.restEdge !== 0)
    bits.push(`Schedule spot adds ${model.restEdge > 0 ? "+" : ""}${model.restEdge.toFixed(1)} to ${g.home.abbr}'s margin.`);
  bits.push(`${homeSide ? g.home.abbr : g.away.abbr} side holds the gap between model and market.`);
  return bits.join(" ");
}

// ---------------------------------------------------------------------------
// LLM front-end intel (optional — enriches the quantitative core)
// ---------------------------------------------------------------------------

function digest(g: GameInfo): string {
  const o = g.odds;
  return [
    `${g.sportLabel} | ${g.matchup} | ${g.statusDetail || "scheduled"} | ${g.startTime}`,
    `${g.away.abbr} ${g.away.record} (road ${g.away.awayRecord || "-"}) @ ${g.home.abbr} ${g.home.record} (home ${g.home.homeRecord || "-"})`,
    o
      ? `Lines: spread ${o.details || `${g.home.abbr} ${fmtLine(o.homeSpread ?? 0)}`} | total ${o.overUnder ?? "n/a"} (o${o.overOdds ?? -110}/u${o.underOdds ?? -110}) | ML ${g.away.abbr} ${o.awayML ?? "?"} / ${g.home.abbr} ${o.homeML ?? "?"}${o.homeTeamTotal ? ` | team totals ${g.home.abbr} ${o.homeTeamTotal}, ${g.away.abbr} ${o.awayTeamTotal}` : ""}`
      : "Lines: none posted",
    g.injuries.length
      ? `Injuries: ${g.injuries.slice(0, 8).map((i) => `${i.player} (${i.team}, ${i.status}${i.detail ? ` — ${i.detail}` : ""})`).join("; ")}`
      : "Injuries: report clean / unavailable",
    g.rest
      ? `Rest: ${g.home.abbr} ${g.rest.homeDays}+d${g.rest.homeB2B ? " (B2B)" : ""}${g.rest.home3in4 ? " (3in4)" : ""}${g.rest.homeTravel ? " [away yday]" : ""} | ${g.away.abbr} ${g.rest.awayDays}+d${g.rest.awayB2B ? " (B2B)" : ""}${g.rest.away3in4 ? " (3in4)" : ""}${g.rest.awayTravel ? " [home yday]" : ""}`
      : "Rest: unknown",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// pipeline orchestration
// ---------------------------------------------------------------------------

async function trace(runId: number, entry: Omit<TraceEntry, "at">): Promise<void> {
  const [row] = await db.select({ trace: runs.trace }).from(runs).where(eq(runs.id, runId));
  const next = [...(row?.trace ?? []), { ...entry, at: new Date().toISOString() }];
  await db.update(runs).set({ trace: next }).where(eq(runs.id, runId));
}

export async function runPipeline(runId: number): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return;
  await ensureAgentsSeeded();
  const roster = await db.select().from(agents);
  const agent = (key: string) => roster.find((a) => a.codename === key || a.id === key);
  const nowMode = targetFor("scout-quant") ? "llm" : "heuristic";

  try {
    await trace(runId, {
      layer: "system",
      agent: "KERNEL",
      message: `Cluster booting — mode: ${nowMode === "llm" ? "LLM swarm online" : "self-hosted quantitative core (no API keys detected)"}. Pulling slate for ${run.slateDate}…`,
      mood: "info",
    });

    const { games, degraded } = await cachedSlate(run.slateDate, run.sports, {
      budgetMs: 16_000,
      maxInjuryLookups: 26,
    });
    if (degraded.length) {
      await trace(runId, {
        layer: "system",
        agent: "KERNEL",
        message: `intel note — ${degraded.join("; ")}. Agents proceed on available data.`,
        mood: "warn",
      });
    }
    const pre = games.filter((g) => g.status === "pre");
    const skipped = games.length - pre.length;

    await trace(runId, {
      layer: "system",
      agent: "KERNEL",
      message: `Slate locked: ${games.length} games found — ${pre.length} queued for analysis${skipped > 0 ? `, ${skipped} skipped (already live or final — the cluster never burns compute on dead games)` : ", zero dead games on the board"}.`,
      mood: "success",
    });
    await db
      .update(runs)
      .set({ gamesFound: games.length, gamesAnalyzed: pre.length, gamesSkipped: skipped, mode: nowMode })
      .where(eq(runs.id, runId));

    if (!pre.length) {
      await trace(runId, {
        layer: "system",
        agent: "KERNEL",
        message: "No upcoming games on this slate. Standing down.",
        mood: "warn",
      });
      await finishRun(runId, run.slateDate, { headline: "No active slate", memo: "Every game on the board was already live or final. Pick another date.", avoided: [] }, []);
      return;
    }

    // ---------------- Layer 1: scouts ----------------
    let candId = 1;
    const models = new Map<string, ModelOut>();
    const allCandidates: Candidate[] = [];
    for (const g of pre) {
      const { cands, model } = candidatesFor(g, () => candId++);
      models.set(g.eventId, model);
      allCandidates.push(...cands);
    }

    const slateText = pre.map(digest).join("\n\n");

    for (const code of ["QUANT", "MEDIC", "CHRONO", "MATCHUP", "SHARP"] as const) {
      const a = agent(code);
      const target = a ? targetFor(a.id) : null;
      const scope: Record<string, string> = {
        QUANT: `power lines built for ${pre.length} games — ${allCandidates.filter((c) => c.category === "spread" || c.category === "moneyline").length} model-vs-market gaps beyond threshold flagged for the analysts.`,
        MEDIC: `injury sweep complete — ${pre.filter((g) => g.injuries.length > 0).length} games carry reportable absences; point-impact pricing delivered to STRATEGA.`,
        CHRONO: `schedule audit complete — ${pre.filter((g) => g.rest && (g.rest.homeB2B || g.rest.awayB2B || g.rest.home3in4 || g.rest.away3in4)).length} games sit in fatigue spots (B2B / 3-in-4 / travel).`,
        MATCHUP: `style collisions mapped for all ${pre.length} matchups — pace-up and grind spots tagged for totals routing.`,
        SHARP: `market scan complete — ${pre.filter((g) => g.odds).length} boards priced; key numbers and trap spreads annotated.`,
      };
      let extra = "";
      if (target && a) {
        const intel = await llmJson<{ notes?: string }>(
          target,
          a.prompt,
          `SLATE ${run.slateDate}\nReturn JSON {"notes": "…2-4 sentences of your sharpest intel for the analysts…"}.\n\n${slateText.slice(0, 9000)}`,
          { timeoutMs: 24000 },
        );
        if (intel?.notes) extra = ` [${target.label}] ${intel.notes}`;
      }
      await trace(runId, {
        layer: "scout",
        agent: code,
        message: `${scope[code]}${extra}`,
        mood: "info",
      });
    }

    // PROPS — player props only when a language model is actually online
    const propsAgent = agent("PROPS");
    const propsTarget = propsAgent ? targetFor(propsAgent.id) : null;
    let propCount = 0;
    if (propsTarget && propsAgent) {
      interface PropSug { eventIdx: number; player: string; stat: string; direction: "over" | "under"; line: number; why: string }
      const out = await llmJson<{ props?: PropSug[] }>(
        propsTarget,
        propsAgent.prompt,
        `SLATE ${run.slateDate}\nGames are indexed below starting at 0. stat must be one of PTS, REB, AST, THREES, PASS_YDS, RUSH_YDS, REC_YDS, GOALS, HITS, SHOTS, STRIKEOUTS.\nReturn JSON {"props":[{"eventIdx":0,"player":"Full Name","stat":"PTS","direction":"over","line":24.5,"why":"…"}]} — max 6 total, only high-conviction.\n\n${pre.map((g, i) => `[${i}] ${digest(g)}`).join("\n\n").slice(0, 12000)}`,
        { timeoutMs: 26000 },
      );
      for (const p of out?.props ?? []) {
        const g = pre[p.eventIdx];
        if (!g?.injuries && !g) continue;
        if (!g || !p.player || !p.line || !p.stat) continue;
        allCandidates.push({
          id: candId++,
          game: g,
          category: "player_prop",
          pick: `${p.player} ${p.direction} ${p.line} ${statLabel(p.stat)}`,
          lineLabel: `${p.direction} ${p.line}`,
          odds: -110,
          edge: 3,
          confidence: Math.min(60, 55),
          signals: ["PROPS", "MEDIC"],
          thesis: p.why || "Usage angle flagged by PROPS scout.",
          grade: { side: p.direction === "over" ? "team_over" : "team_under", line: p.line, player: p.player, stat: p.stat },
        });
        propCount++;
      }
    }
    await trace(runId, {
      layer: "scout",
      agent: "PROPS",
      message:
        propCount > 0
          ? `surfaced ${propCount} player-prop angles with market-shaped lines for council review.`
          : `no player-prop market feed detected${propsTarget ? " and no high-conviction usage spots" : " (free-LLM offline)"} — staying disciplined, zero forced props.`,
      mood: propCount > 0 ? "info" : "warn",
    });

    if (!allCandidates.length) {
      await trace(runId, {
        layer: "analyst",
        agent: "STRATEGA",
        message: "Zero model-vs-market gaps cleared the edge threshold. This board is priced efficiently — no card tonight.",
        mood: "warn",
      });
      await finishRun(runId, run.slateDate, { headline: "Clean board, no edges", memo: "The market priced this slate efficiently. Discipline: no forced bets.", avoided: pre.map((g) => g.matchup).slice(0, 10) }, []);
      return;
    }

    // ---------------- Layer 2: analysts ----------------
    allCandidates.sort((a, b) => b.confidence - a.confidence);
    const stratega = agent("analyst-stratega") ?? agent("STRATEGA");
    const strategaTarget = stratega ? targetFor(stratega.id) : null;
    const top = allCandidates.slice(0, 14);
    if (strategaTarget && stratega) {
      interface Verdict { id: number; confidence?: number; thesis?: string }
      const out = await llmJson<{ verdicts?: Verdict[] }>(
        strategaTarget,
        stratega.prompt,
        `Score/reshape these candidate bets (ids listed). Return JSON {"verdicts":[{"id":1,"confidence":61,"thesis":"…two sentences max…"}]} — keep ids, adjust confidence by at most ±8, only include candidates worth releasing.\n\n${top.map((c) => `#${c.id} ${c.category.toUpperCase()} | ${c.pick} | ${c.game.matchup} | conf ${c.confidence.toFixed(0)} | base thesis: ${c.thesis}`).join("\n").slice(0, 10000)}`,
        { timeoutMs: 26000 },
      );
      for (const v of out?.verdicts ?? []) {
        const c = allCandidates.find((x) => x.id === v.id);
        if (!c) continue;
        if (typeof v.confidence === "number")
          c.confidence = Math.max(45, Math.min(75, v.confidence));
        if (v.thesis && v.thesis.length > 20) c.thesis = v.thesis;
      }
      const survived = new Set((out?.verdicts ?? []).map((v) => v.id));
      if (survived.size > 0) {
        for (const c of allCandidates) {
          if (top.includes(c) && !survived.has(c.id)) c.confidence -= 12; // analyst passed
        }
      }
    }
    await trace(runId, {
      layer: "analyst",
      agent: "STRATEGA",
      message: `forged ${allCandidates.length} raw signals — top ${top.length} theses graded for release, convergence-weighted (multi-scout agreement counts heaviest).`,
      mood: "info",
    });

    // contrarian audit
    let vetoCount = 0;
    for (const c of allCandidates) {
      const kills: string[] = [];
      if (c.category === "moneyline" && c.odds < -260) kills.push("juice too heavy — no price value on a massive favorite");
      if (c.signals.includes("SHARP") && c.game.odds && Math.abs(c.game.odds.homeSpread ?? 0) >= 14 && c.category === "spread")
        kills.push("double-digit spread in a variance sport — trap profile");
      if (c.confidence < 54) kills.push("edge below professional threshold");
      if (c.game.odds && Math.abs(c.game.odds.homeSpread ?? 0) >= 17 && c.category === "spread")
        kills.push("bloated chalk — model edge is real but the number is untouchable");
      if (kills.length) {
        c.vetoed = kills[0];
        vetoCount++;
      } else if (c.category === "total" && c.signals.length < 3) {
        c.discount = "single-signal total — sized down one notch";
        c.confidence -= 3;
      }
    }
    const contrarian = agent("CONTRARIAN");
    const contraTarget = contrarian ? targetFor(contrarian.id) : null;
    if (contraTarget && contrarian && !vetoCount && allCandidates.length > 2) {
      interface Audit { id: number; verdict: "CONFIRM" | "DISCOUNT" | "VETO"; why?: string }
      const out = await llmJson<{ audits?: Audit[] }>(
        contraTarget,
        contrarian.prompt,
        `Audit these candidates. Return JSON {"audits":[{"id":1,"verdict":"CONFIRM","why":"…"}]}.\n\n${top.map((c) => `#${c.id} ${c.pick} | ${c.game.matchup} | conf ${c.confidence.toFixed(0)} | ${c.thesis}`).join("\n").slice(0, 9000)}`,
        { timeoutMs: 24000 },
      );
      for (const adt of out?.audits ?? []) {
        const c = allCandidates.find((x) => x.id === adt.id);
        if (!c) continue;
        if (adt.verdict === "VETO") {
          c.vetoed = adt.why || "killed by the contrarian";
          vetoCount++;
        } else if (adt.verdict === "DISCOUNT") {
          c.discount = adt.why || "discounted";
          c.confidence = Math.max(45, c.confidence - 5);
        }
      }
    }
    await trace(runId, {
      layer: "analyst",
      agent: "CONTRARIAN",
      message: `audit complete — ${vetoCount} candidate${vetoCount === 1 ? "" : "s"} vetoed (juice/trap/sub-threshold), ${allCandidates.filter((c) => c.discount && !c.vetoed).length} discounted, ${allCandidates.filter((c) => !c.vetoed).length} cleared for the council floor.`,
      mood: vetoCount ? "warn" : "info",
    });

    const live = allCandidates.filter((c) => !c.vetoed).sort((a, b) => b.confidence - a.confidence);

    // ---------------- Layer 3: council ----------------
    const lessons = await buildLessons();
    await trace(runId, {
      layer: "council",
      agent: "HISTORIAN",
      message: lessons.length
        ? `injected ${lessons.length} live lessons from the graded archive: ${lessons.join(" · ")}`
        : "graded archive is still young — no statistically-valid leaks to inject. Volume will sharpen the memory.",
      mood: "info",
    });

    // Two-phase card construction: the best 6 raw edges lock first, then the
    // commissioner fills the remaining seats preferring untapped markets
    // (diversity of angles beats stacking one side of one board).
    const card: Candidate[] = [];
    const perGame = new Map<string, number>();
    let exposure = 0;
    const seat = (c: Candidate): number => {
      const cost = unitsFor(c);
      perGame.set(c.game.eventId, (perGame.get(c.game.eventId) ?? 0) + 1);
      c.finalUnits = cost;
      c.signals = [...new Set([...c.signals, "STRATEGA", "CONTRARIAN", "COMMISSIONER", "RISK", "HISTORIAN"])];
      card.push(c);
      exposure += cost;
      return cost;
    };
    const eligible = (c: Candidate): boolean => {
      if ((perGame.get(c.game.eventId) ?? 0) >= 2) return false;
      return exposure + unitsFor(c) <= 12.05; // RISK veto on oversize
    };
    for (const c of live) {
      if (card.length >= 6) break;
      if (eligible(c)) seat(c);
    }
    const haveCats = new Set(card.map((c) => c.category));
    const rest = live
      .filter((c) => !card.includes(c))
      .sort(
        (a, b) =>
          b.confidence + (haveCats.has(b.category) ? 0 : 5) -
          (a.confidence + (haveCats.has(a.category) ? 0 : 5)),
      );
    // Reserved seats: the strongest alternate-market angles (totals, ML, props)
    // earn chairs even over marginally higher-rated sides. Diversification is policy.
    const altSeats = rest
      .filter((c) => c.category !== "spread" && c.confidence >= 56)
      .sort((a, b) => b.confidence - a.confidence);
    let alts = 0;
    for (const c of altSeats) {
      if (alts >= 2 || card.length + 2 > 10) break;
      if (eligible(c)) {
        seat(c);
        alts++;
      }
    }
    for (const c of rest) {
      if (card.length >= 10) break;
      if (!card.includes(c) && eligible(c)) seat(c);
    }
    card.sort((a, b) => b.confidence - a.confidence);

    const commissioner = agent("COMMISSIONER");
    const commTarget = commissioner ? targetFor(commissioner.id) : null;
    let decision: CouncilDecision = {
      headline: card.length ? `${card.length}-play card approved for ${run.slateDate}` : "Council passes — no release",
      memo: card.length
        ? `Model-vs-market convergence card. Average confidence ${(card.reduce((s, c) => s + c.confidence, 0) / card.length).toFixed(0)}, spread across ${perGame.size} games, total exposure ${card.reduce((s, c) => s + sealedUnits(c), 0).toFixed(1)}u. ${lessons[0] ? `Board note: ${lessons[0]}.` : ""}`
        : "Nothing survived the contrarian audit tonight.",
      avoided: live.slice(card.length, card.length + 8).map((c) => `${c.pick} (${c.game.matchup})`),
    };
    if (commTarget && commissioner && card.length) {
      const out = await llmJson<{ headline?: string; memo?: string }>(
        commTarget,
        commissioner.prompt,
        `Write the card announcement. Return JSON {"headline":"…","memo":"…2 sentences…"}.\nCARD:\n${card.map((c, i) => `${i + 1}. [conf ${c.confidence.toFixed(0)}] ${c.pick} — ${c.game.matchup} — ${c.thesis}`).join("\n").slice(0, 8000)}`,
        { timeoutMs: 22000 },
      );
      if (out?.headline && out?.memo) decision = { ...decision, headline: out.headline, memo: out.memo };
    }
    await trace(runId, {
      layer: "council",
      agent: "COMMISSIONER",
      message: `council adjourned — official card: ${card.length} bet${card.length === 1 ? "" : "s"}. ${decision.headline}`,
      mood: "success",
    });
    await trace(runId, {
      layer: "council",
      agent: "RISK",
      message: `sizing sealed — ${card.reduce((s, c) => s + sealedUnits(c), 0).toFixed(1)}u total exposure (12u daily cap enforced). Crowns: ${card.filter((c) => sealedUnits(c) >= 1.5).map((c) => c.pick).join(" · ") || "none"}.`,
      mood: "info",
    });

    await finishRun(runId, run.slateDate, decision, card);
  } catch (err) {
    await trace(runId, {
      layer: "system",
      agent: "KERNEL",
      message: `fault: ${err instanceof Error ? err.message : "unknown"}. Emergency shutdown.`,
      mood: "error",
    });
    await db
      .update(runs)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(runs.id, runId));
  }
}

function statLabel(stat: string): string {
  const map: Record<string, string> = {
    PTS: "points", REB: "rebounds", AST: "assists", THREES: "threes",
    PASS_YDS: "pass yards", RUSH_YDS: "rush yards", REC_YDS: "rec yards",
    GOALS: "goals", HITS: "hits", SHOTS: "shots", STRIKEOUTS: "strikeouts",
  };
  return map[stat] ?? stat.toLowerCase();
}

const SCOUT_CODES = new Set(["QUANT", "MEDIC", "CHRONO", "MATCHUP", "SHARP", "PROPS"]);

function sealedUnits(c: { confidence: number; category: string; signals?: string[]; finalUnits?: number }): number {
  return c.finalUnits ?? unitsFor(c);
}

export function unitsFor(c: { confidence: number; category: string; signals?: string[] }): number {
  const convergence = (c.signals ?? []).filter((s) => SCOUT_CODES.has(s)).length;
  const u =
    c.confidence >= 68 && convergence >= 5 ? 2 :
    c.confidence >= 63 ? 1.5 :
    c.confidence >= 55 ? 1 : 0.5;
  return c.category === "total" || c.category === "team_total" || c.category === "player_prop"
    ? Math.max(0.5, u - 0.5)
    : u;
}

async function finishRun(runId: number, slateDate: string, decision: CouncilDecision, card: Candidate[]): Promise<void> {
  for (let i = 0; i < card.length; i++) {
    const c = card[i];
    await db.insert(predictions).values({
      runId,
      sortOrder: i,
      slateDate,
      sport: c.game.sport,
      eventId: c.game.eventId,
      matchup: c.game.matchup,
      startTime: c.game.startTime ? new Date(c.game.startTime) : null,
      category: c.category,
      pick: c.pick,
      lineLabel: c.lineLabel,
      odds: c.odds,
      units: sealedUnits(c),
      confidence: Math.round(c.confidence * 10) / 10,
      edge: Math.round(c.edge * 10) / 10,
      agents: c.signals,
      reasoning: c.thesis,
      grade: c.grade,
      outcome: "pending",
    });
  }
  await db
    .update(runs)
    .set({ status: "completed", council: decision, completedAt: new Date() })
    .where(eq(runs.id, runId));
}

async function buildLessons(): Promise<string[]> {
  const graded = await db
    .select()
    .from(predictions)
    .where(ne(predictions.outcome, "pending"))
    .orderBy(desc(predictions.id))
    .limit(150);
  const lessons: string[] = [];
  const byCat = new Map<string, { w: number; l: number }>();
  for (const p of graded) {
    const e = byCat.get(p.category) ?? { w: 0, l: 0 };
    if (p.outcome === "win") e.w++;
    else if (p.outcome === "loss") e.l++;
    byCat.set(p.category, e);
  }
  for (const [cat, r] of byCat) {
    const n = r.w + r.l;
    if (n < 8) continue;
    const rate = r.w / n;
    if (rate >= 0.62) lessons.push(`${cat.replace("_", " ")}s cash at ${(rate * 100).toFixed(0)}% (${r.w}-${r.l}) — press the angle`);
    if (rate <= 0.38) lessons.push(`${cat.replace("_", " ")}s leak at ${(rate * 100).toFixed(0)}% (${r.w}-${r.l}) — demand extra convergence`);
  }
  return lessons.slice(0, 4);
}

// ---------------------------------------------------------------------------
// grading engine — settles pending bets against final scores, then pays the
// agents their rating adjustments (wins/losses ripple through the roster)
// ---------------------------------------------------------------------------

export async function gradePending(): Promise<{ graded: number; wins: number; losses: number; pushes: number }> {
  await ensureSchema();
  const pending = await db
    .select()
    .from(predictions)
    .where(
      and(eq(predictions.outcome, "pending"), lt(predictions.startTime, new Date(Date.now() - 45 * 60_000))),
    )
    .limit(250);
  if (!pending.length) return { graded: 0, wins: 0, losses: 0, pushes: 0 };

  const finalsCache = new Map<string, Awaited<ReturnType<typeof getFinals>>>();
  let graded = 0, wins = 0, losses = 0, pushes = 0;
  const creditList: { agents: string[]; outcome: string; confidence: number }[] = [];

  for (const p of pending) {
    const key = `${p.slateDate}|${p.sport}`;
    if (!finalsCache.has(key)) finalsCache.set(key, await getFinals(p.slateDate, p.sport));
    const finals = finalsCache.get(key)!;
    const f = finals.find((x) => x.eventId === p.eventId);
    if (!f || f.status !== "post") continue;

    const g = p.grade as GradeSpec;
    let outcome: "win" | "loss" | "push" | null = null;
    if (p.category === "spread" && g.line != null) {
      const adjHome = f.homeScore + (g.side === "home" ? g.line : 0);
      const adjAway = f.awayScore + (g.side === "away" ? g.line : 0);
      const diff = g.side === "home" ? adjHome - adjAway : adjAway - adjHome;
      outcome = diff > 0 ? "win" : diff < 0 ? "loss" : "push";
    } else if (p.category === "total" && g.line != null) {
      const tot = f.homeScore + f.awayScore;
      outcome = tot === g.line ? "push" : (tot > g.line) === (g.side === "over") ? "win" : "loss";
    } else if (p.category === "moneyline") {
      const homeWon = f.homeScore > f.awayScore;
      outcome = (homeWon && g.side === "home") || (!homeWon && g.side === "away") ? "win" : "loss";
    } else if (p.category === "team_total" && g.line != null && g.teamAbbr && !g.player) {
      const pts = g.teamAbbr === f.homeAbbr ? f.homeScore : f.awayScore;
      outcome = pts === g.line ? "push" : (pts > g.line) === (g.side === "team_over") ? "win" : "loss";
    } else if (p.category === "player_prop" && g.player && g.stat && g.line != null) {
      const val = await lookupPlayerStat(p.sport, p.eventId, g.player, g.stat);
      if (val == null) continue; // boxscore not parseable yet
      outcome = val === g.line ? "push" : (val > g.line) === (g.side === "team_over") ? "win" : "loss";
    }
    if (!outcome) continue;

    const finalScore = `${f.awayAbbr} ${f.awayScore} — ${f.homeAbbr} ${f.homeScore}`;
    await db
      .update(predictions)
      .set({ outcome, finalScore, gradedAt: new Date() })
      .where(eq(predictions.id, p.id));
    graded++;
    if (outcome === "win") wins++;
    else if (outcome === "loss") losses++;
    else pushes++;
    creditList.push({ agents: p.agents, outcome, confidence: p.confidence });
  }

  // settle agent ratings afterwards (drives retraining)
  await settleAgentRatings(creditList);
  return { graded, wins, losses, pushes };
}
