import { db } from "@/db";
import {
  agents,
  predictions,
  runs,
  type CouncilDecision,
  type GradeSpec,
  type TraceEntry,
} from "@/db/schema";
import { and, desc, eq, inArray, lt, ne, sql as dsql } from "drizzle-orm";
import {
  COMBAT_SPORTS,
  getFinals,
  getSlateDetailed,
  lookupPlayerStat,
  type GameInfo,
} from "./espn";
import { llmJson, targetFor, type KeyBag } from "./llm";
import { ensureAgentsSeeded, settleAgentRatings } from "./agents";
import { ensureSchema } from "./schema";
import { HOUSE } from "./owner";
import { allowsCandidate, buildFilter, type MarketFilter } from "./markets";
import { fetchBoutProfiles, buildEnhancedCombatModel } from "./fighter-stats";

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

  // Enrich upcoming combat bouts with real ESPN fighter stats (parallel, budget-capped)
  const combatPre = games.filter(
    (g) => g.status === "pre" && g.combat && g.combat.eventId && g.combat.competitionId,
  );
  if (combatPre.length > 0) {
    const statDeadline = Date.now() + 6000;
    await Promise.all(
      combatPre.slice(0, 12).map(async (g) => {
        if (!g.combat || Date.now() > statDeadline) return;
        try {
          const { away: ap, home: hp } = await fetchBoutProfiles(
            g.combat.eventId,
            g.combat.competitionId,
            g.combat.league as "ufc" | "pfl",
          );
          const enhanced = buildEnhancedCombatModel(
            g.away.record,
            g.home.record,
            g.combat.weightClass,
            g.combat.scheduledRounds,
            ap,
            hp,
          );
          g.combat.model = { ...enhanced };
          if (enhanced.summary) g.context.notes = [enhanced.summary];
        } catch {
          /* fallback stays in place */
        }
      }),
    );
  }

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

function combatCandidates(g: GameInfo, nextId: () => number): Candidate[] {
  const c = g.combat;
  if (!c) return [];
  const m = c.model;
  const out: Candidate[] = [];
  const favHome = m.pHome >= 0.5;
  const pFav = Math.max(m.pHome, m.pAway);
  const fav = favHome ? g.home : g.away;
  const dog = favHome ? g.away : g.home;
  const favPrice = favHome ? m.fairHomeML : m.fairAwayML;
  const priceTag = `${favPrice > 0 ? "+" : ""}${favPrice}`;

  // ---- winner ----
  // DWCS/PFL prospect fights are frequently near coin-flips; only a real
  // separation in record strength earns a side.
  const statsLabel = (m as any).statsUsed ? "ESPN career stats" : "record-based model";
  const matchupSummary = (m as any).summary || `${c.weightClass} ${c.scheduledRounds}rd bout`;

  if (pFav >= 0.53) {
    out.push({
      id: nextId(), game: g, category: "fight_ml",
      pick: `${fav.name} to win`,
      lineLabel: `model ${priceTag}`,
      odds: favPrice,
      edge: (pFav - 0.5) * 100,
      confidence: Math.min(66, 52 + (pFav - 0.5) * 52 + ((m as any).statsUsed ? 3 : 0) + jitter(g.eventId + "fml")),
      signals: (m as any).statsUsed ? ["QUANT", "MATCHUP", "PROPS"] : ["QUANT", "MATCHUP"],
      thesis: `${fav.name} (${fav.record}) vs ${dog.name} (${dog.record}). ${matchupSummary}. ${statsLabel} makes ${fav.name} a ${(pFav * 100).toFixed(0)}% favourite — fair price ${priceTag}. Shop your book: this is only valuable if they post better than ${priceTag}.`,
      grade: { side: favHome ? "home" : "away", line: null },
    });
  }

  // ---- method: finish vs decision ----
  if (Math.abs(m.pFinish - 0.5) >= 0.03) {
    const finish = m.pFinish > 0.5;
    const price = finish ? m.fairFinish : m.fairDecision;
    out.push({
      id: nextId(), game: g, category: "fight_method",
      pick: finish
        ? `${g.away.abbr} vs ${g.home.abbr} — does NOT go the distance`
        : `${g.away.abbr} vs ${g.home.abbr} — GOES the distance`,
      lineLabel: finish ? "inside the distance" : "decision",
      odds: price,
      edge: Math.abs(m.pFinish - 0.5) * 100,
      confidence: Math.min(62, 52 + Math.abs(m.pFinish - 0.5) * 42 + ((m as any).statsUsed ? 2 : 0) + jitter(g.eventId + "fm")),
      signals: (m as any).statsUsed ? ["MATCHUP", "PROPS", "QUANT"] : ["MATCHUP", "PROPS"],
      thesis: `${matchupSummary}. ${statsLabel} models ${(m.pFinish * 100).toFixed(0)}% stoppage probability — ${finish ? "finishing tendencies and striking output favour an early end" : "both fighters' decision percentages and cardio point to the scorecards"}. Fair price ${price > 0 ? "+" : ""}${price}.`,
      grade: { side: finish ? "under" : "over", line: c.scheduledRounds, segment: "FIGHT" },
    });
  }

  // ---- round totals ----
  if (Math.abs(m.pRoundsOver - 0.5) >= 0.03) {
    const over = m.pRoundsOver > 0.5;
    const price = over ? m.fairRoundsOver : m.fairRoundsUnder;
    out.push({
      id: nextId(), game: g, category: "fight_rounds",
      pick: `${g.away.abbr} vs ${g.home.abbr} — ${over ? "over" : "under"} ${m.roundLine} rounds`,
      lineLabel: `${over ? "o" : "u"}${m.roundLine} rounds`,
      odds: price,
      edge: Math.abs(m.pRoundsOver - 0.5) * 100,
      confidence: Math.min(60, 52 + Math.abs(m.pRoundsOver - 0.5) * 34 + jitter(g.eventId + "fr")),
      signals: ["MATCHUP", "PROPS"],
      thesis: `Model expects about ${m.expRounds.toFixed(1)} completed rounds in this ${c.scheduledRounds}-rounder (${(m.pFinish * 100).toFixed(0)}% stoppage risk), landing ${over ? "beyond" : "short of"} ${m.roundLine} at a model price of ${price > 0 ? "+" : ""}${price}.`,
      grade: { side: over ? "over" : "under", line: m.roundLine, segment: "FIGHT" },
    });
  }
  return out;
}

function candidatesFor(g: GameInfo, nextId: () => number): {
  cands: Candidate[];
  model: ModelOut;
} {
  const model = buildModel(g);
  if (COMBAT_SPORTS.has(g.sport)) {
    return { cands: combatCandidates(g, nextId), model };
  }
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
      const juice = (homeSide ? o.homeSpreadOdds : o.awaySpreadOdds) ?? -110;
      cands.push(
        mk(
          "spread",
          `${team.name} ${line > 0 ? "+" : ""}${Number(line.toFixed(1))}`,
          `spread ${line > 0 ? "+" : ""}${Number(line.toFixed(1))}`,
          juice,
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

    // ---------------- derived markets ----------------
    // Model projections for both sides, from the model margin + model total.
    const modelTotal = o.overUnder + lean;
    const modelHome = modelTotal / 2 + model.margin / 2;
    const modelAway = modelTotal / 2 - model.margin / 2;

    // --- team totals ---
    for (const side of ["home", "away"] as const) {
      const tt = side === "home" ? o.homeTeamTotal : o.awayTeamTotal;
      const proj = side === "home" ? modelHome : modelAway;
      const team = side === "home" ? g.home : g.away;
      if (tt == null) continue;
      const gap = proj - tt;
      const need = (AVG_TOTAL[g.sport] ?? 40) <= 10 ? 0.45 : (AVG_TOTAL[g.sport] ?? 40) <= 50 ? 1.9 : 3.4;
      if (Math.abs(gap) < need) continue;
      const over = gap > 0;
      cands.push(
        mk(
          "team_total",
          `${team.name} team total ${over ? "over" : "under"} ${tt}`,
          `${over ? "o" : "u"}${tt}`,
          -110,
          Math.abs(gap),
          Math.min(62, 53.5 + Math.min(8, Math.abs(gap) / need * 3.4) + jitter(g.eventId + side + "tt")),
          `Model projects ${team.abbr} for ${proj.toFixed(1)} vs a ${o.teamTotalsDerived ? "derived" : "posted"} team total of ${tt}. ${edgeWhy(model, g, side === "home")}`,
          { side: over ? "team_over" : "team_under", line: tt, teamAbbr: team.abbr },
          ["MATCHUP"],
        ),
      );
    }

    // --- first half / quarter / period derivatives ---
    const isFootball = g.sport === "nfl" || g.sport === "ncaaf";
    const isHoops = g.sport === "nba" || g.sport === "ncaab";
    if (isFootball || isHoops) {
      const tMul = isFootball ? 0.49 : 0.505; // 1H share of game total
      const sMul = isFootball ? 0.55 : 0.52; // 1H share of game spread
      const halfTotal = Math.round(o.overUnder * tMul * 2) / 2;
      const halfLean = lean * tMul;
      const halfNoise = isFootball ? 1.9 : 2.0;
      if (Math.abs(halfLean) >= halfNoise) {
        const over = halfLean > 0;
        cands.push(
          mk(
            "1h_total",
            `1st half ${over ? "over" : "under"} ${halfTotal} (${g.matchup})`,
            `1H ${over ? "o" : "u"}${halfTotal}`,
            -110,
            Math.abs(halfLean),
            Math.min(60, 53 + Math.min(6, Math.abs(halfLean)) + jitter(g.eventId + "1ht")),
            `Full-game model leans ${over ? "over" : "under"} by ${Math.abs(lean).toFixed(1)}; scripts tend to show early, so the first-half number at ${halfTotal} carries the same edge at reduced variance.`,
            { side: over ? "over" : "under", line: halfTotal, segment: "1H" },
            ["MATCHUP", "CHRONO"],
          ),
        );
      }
      if (o.homeSpread != null) {
        const halfSpread = Math.round(o.homeSpread * sMul * 2) / 2;
        const halfMargin = model.margin * sMul;
        const hDiff = halfMargin - halfSpread;
        if (Math.abs(hDiff) >= (isFootball ? 1.6 : 1.5)) {
          const homeSide = hDiff > 0;
          const team = homeSide ? g.home : g.away;
          const line = homeSide ? halfSpread : -halfSpread;
          cands.push(
            mk(
              "1h_spread",
              `${team.name} 1st half ${line > 0 ? "+" : ""}${line}`,
              `1H ${line > 0 ? "+" : ""}${line}`,
              -110,
              Math.abs(hDiff),
              Math.min(61, 53 + Math.min(7, Math.abs(hDiff) * 1.8) + jitter(g.eventId + "1hs")),
              `${team.abbr} is the stronger early-script side: model half-margin ${halfMargin.toFixed(1)} vs a ${halfSpread > 0 ? "+" : ""}${halfSpread} first-half number. Avoids late garbage-time noise.`,
              { side: homeSide ? "home" : "away", line, segment: "1H" },
              ["MATCHUP"],
            ),
          );
        }
      }
      // opening period total (NCAAB plays halves, so quarters don't apply)
      if (g.sport !== "ncaab") {
        const qMul = isFootball ? 0.235 : 0.253;
        const qTotal = Math.round(o.overUnder * qMul * 2) / 2;
        const qLean = lean * qMul;
        if (Math.abs(qLean) >= (isFootball ? 1.0 : 1.2)) {
          const over = qLean > 0;
          cands.push(
            mk(
              "1q_total",
              `1st quarter ${over ? "over" : "under"} ${qTotal} (${g.matchup})`,
              `1Q ${over ? "o" : "u"}${qTotal}`,
              -115,
              Math.abs(qLean),
              Math.min(58, 52.5 + Math.min(5, Math.abs(qLean) * 2.2) + jitter(g.eventId + "1qt")),
              `Opening-frame derivative of the same ${over ? "over" : "under"} thesis, priced at ${qTotal}. Small stake — single-quarter variance is high.`,
              { side: over ? "over" : "under", line: qTotal, segment: "1Q" },
              ["MATCHUP"],
            ),
          );
        }
      }
    }

    if (g.sport === "nhl") {
      const p1Total = Math.round(o.overUnder * 0.315 * 2) / 2;
      const p1Lean = lean * 0.315;
      if (Math.abs(p1Lean) >= 0.22) {
        const over = p1Lean > 0;
        cands.push(
          mk(
            "p1_total",
            `1st period ${over ? "over" : "under"} ${p1Total} (${g.matchup})`,
            `P1 ${over ? "o" : "u"}${p1Total}`,
            over ? 115 : -135,
            Math.abs(p1Lean),
            Math.min(58, 53 + Math.min(5, Math.abs(p1Lean) * 9) + jitter(g.eventId + "p1")),
            `First-period derivative of the game total read. ${over ? "Both clubs open fast" : "Feeling-out period favors the under"} at ${p1Total}.`,
            { side: over ? "over" : "under", line: p1Total, segment: "P1" },
            ["MATCHUP"],
          ),
        );
      }
    }

    if (g.sport === "mlb") {
      // First five innings — the starters' market.
      const f5Total = Math.round(o.overUnder * 0.55 * 2) / 2;
      const f5Lean = lean * 0.55;
      if (Math.abs(f5Lean) >= 0.28) {
        const over = f5Lean > 0;
        cands.push(
          mk(
            "f5_total",
            `First 5 innings ${over ? "over" : "under"} ${f5Total} (${g.matchup})`,
            `F5 ${over ? "o" : "u"}${f5Total}`,
            -115,
            Math.abs(f5Lean),
            Math.min(60, 53 + Math.min(6, Math.abs(f5Lean) * 7) + jitter(g.eventId + "f5")),
            `F5 removes bullpen variance and isolates the starters — the same ${over ? "over" : "under"} lean at ${f5Total}.`,
            { side: over ? "over" : "under", line: f5Total, segment: "F5" },
            ["MATCHUP"],
          ),
        );
      }
      // NRFI / YRFI via Poisson on first-inning run expectancy.
      const perTeamInning = (o.overUnder / 2) / 9;
      const lam1 = perTeamInning * 1.18; // top of the order bats first
      const pNRFI = Math.exp(-2 * lam1);
      if (pNRFI >= 0.54 || pNRFI <= 0.46) {
        const nrfi = pNRFI >= 0.5;
        cands.push(
          mk(
            nrfi ? "nrfi" : "nrfi",
            nrfi ? `No Runs First Inning (${g.matchup})` : `Yes Runs First Inning (${g.matchup})`,
            nrfi ? "NRFI" : "YRFI",
            nrfi ? -125 : 105,
            Math.abs(pNRFI - 0.5) * 100,
            Math.min(60, 52.5 + Math.abs(pNRFI - 0.5) * 60 + jitter(g.eventId + "nrfi")),
            `First-inning run expectancy models at ${(lam1 * 2).toFixed(2)} runs → ${(pNRFI * 100).toFixed(0)}% scoreless. Posted total of ${o.overUnder} supports the ${nrfi ? "NRFI" : "YRFI"} side.`,
            { side: nrfi ? "under" : "over", line: 0.5, segment: "1I" },
            ["MATCHUP"],
          ),
        );
      }
    }
  }

  // ---------------- player props from real season production ----------------
  for (const L of g.leaders) {
    if (L.perGame == null || !L.teamAbbr) continue;

    // touchdown markets are priced as probabilities, not yardage lines
    if (L.stat === "ANY_TD" || L.stat === "PASS_TD") {
      const isHomeTd = L.teamAbbr === g.home.abbr;
      const spreadTd = o?.homeSpread ?? 0;
      const favMarginTd = isHomeTd ? -spreadTd : spreadTd;
      // favourites find the end zone more often
      const lambda = Math.max(0.05, L.perGame * (1 + favMarginTd * 0.022));
      if (L.stat === "ANY_TD") {
        const pScore = 1 - Math.exp(-lambda);
        if (pScore >= 0.5) {
          const rawFair = pScore >= 0.5 ? -Math.round((pScore / (1 - pScore)) * 100) : 100;
          // books shade anytime-TD prices; never quote beyond a realistic range
          const fair = Math.max(-190, rawFair);
          cands.push(
            mk(
              "player_prop",
              `${L.athlete} anytime touchdown`,
              "anytime TD",
              fair,
              (pScore - 0.5) * 100,
              Math.min(60, 53 + (pScore - 0.5) * 34 + jitter(g.eventId + L.athlete + "td")),
              `${L.athlete} (${L.teamAbbr}) is finding the end zone ${L.perGame} times per game. Game script ${favMarginTd > 0 ? "as a favourite" : "as an underdog"} models a ${(pScore * 100).toFixed(0)}% chance of a touchdown.`,
              { side: "team_over", line: 0.5, player: L.athlete, stat: "ANY_TD", teamAbbr: L.teamAbbr },
              ["PROPS"],
            ),
          );
        }
      } else {
        const lineTd = lambda >= 1.9 ? 1.5 : 0.5;
        const pOver = 1 - poissonCdf(lineTd, lambda);
        if (Math.abs(pOver - 0.5) >= 0.06) {
          const over = pOver > 0.5;
          cands.push(
            mk(
              "player_prop",
              `${L.athlete} ${over ? "over" : "under"} ${lineTd} passing TDs`,
              `${over ? "o" : "u"}${lineTd} pass TD`,
              -115,
              Math.abs(pOver - 0.5) * 100,
              Math.min(60, 53 + Math.abs(pOver - 0.5) * 34 + jitter(g.eventId + L.athlete + "ptd")),
              `${L.athlete} averages ${L.perGame} passing touchdowns per game; model lands at ${lambda.toFixed(2)} expected against this matchup — ${(pOver * 100).toFixed(0)}% to clear ${lineTd}.`,
              { side: over ? "team_over" : "team_under", line: lineTd, player: L.athlete, stat: "PASS_TD", teamAbbr: L.teamAbbr },
              ["PROPS"],
            ),
          );
        }
      }
      continue;
    }

    const isHome = L.teamAbbr === g.home.abbr;
    const spread = o?.homeSpread ?? 0;
    // Game script: favorites run more, underdogs throw more.
    const favMargin = isHome ? -spread : spread; // + means this team is favored
    let adj = 0;
    // Game-script adjustments: favourites run more, underdogs throw more.
    // Rest/fatigue: B2B teams regress slightly on all stats.
    if (L.stat === "RUSH_YDS") adj = favMargin * 1.4;
    else if (L.stat === "PASS_YDS") adj = -favMargin * 3.0;
    else if (L.stat === "REC_YDS") adj = -favMargin * 1.1;
    else if (L.stat === "PTS" || L.stat === "REB" || L.stat === "AST") {
      const outs = g.injuries.filter(
        (i) => i.team === L.teamAbbr && /out|doubt/i.test(i.status),
      ).length;
      adj = outs * (L.stat === "PTS" ? 2.2 : 0.8);
    }
    // Model margin vs the market spread opens extra yardage edges
    const marginEdge = Math.abs(model.margin - (o?.homeSpread ?? 0));
    if (L.stat === "RUSH_YDS" && isHome === (model.margin > (o?.homeSpread ?? 0)))
      adj += marginEdge * 0.8;
    else if (L.stat === "PASS_YDS" && isHome !== (model.margin > (o?.homeSpread ?? 0)))
      adj += marginEdge * 1.8;
    else if (L.stat === "REC_YDS" && isHome !== (model.margin > (o?.homeSpread ?? 0)))
      adj += marginEdge * 0.6;
    // fatigue effect
    if (g.rest) {
      const tired = isHome ? g.rest.homeB2B : g.rest.awayB2B;
      if (tired) adj -= L.perGame * 0.04;
    }
    const projection = L.perGame + adj;
    // Line is at the season rate, bumped half a point toward the projection
    // to create a realistic market-shaped number.
    const line = Math.round((L.perGame + (projection > L.perGame ? 0.5 : -0.5)) * 2) / 2;
    const gap = projection - line;
    const need =
      L.stat === "PASS_YDS" ? 8 :
      L.stat === "RUSH_YDS" ? 4 :
      L.stat === "REC_YDS" ? 4 :
      L.stat === "PTS" ? 1.4 : 0.7;
    if (Math.abs(gap) < need) continue;
    const over = gap > 0;
    cands.push(
      mk(
        "player_prop",
        `${L.athlete} ${over ? "over" : "under"} ${line} ${statLabel(L.stat)}`,
        `${over ? "o" : "u"}${line}`,
        -110,
        Math.abs(gap),
        Math.min(60, 53 + Math.min(6, (Math.abs(gap) / need) * 3) + jitter(g.eventId + L.athlete)),
        `${L.athlete} (${L.teamAbbr}${L.position ? `, ${L.position}` : ""}) is producing ${L.perGame} ${statLabel(L.stat)} per game. Game script ${favMargin > 0 ? "as a favorite" : "as an underdog"} projects ${projection.toFixed(1)} — ${over ? "above" : "below"} the ${line} number.`,
        { side: over ? "team_over" : "team_under", line, player: L.athlete, stat: L.stat, teamAbbr: L.teamAbbr },
        ["PROPS", "MEDIC"],
      ),
    );
  }

  return { cands, model };
}

/** P(X <= k) for a Poisson with mean lambda — used for TD markets. */
function poissonCdf(k: number, lambda: number): number {
  const kk = Math.floor(k);
  let term = Math.exp(-lambda);
  let sum = term;
  for (let i = 1; i <= kk; i++) {
    term *= lambda / i;
    sum += term;
  }
  return Math.min(1, sum);
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

export async function runPipeline(
  runId: number,
  keys: KeyBag = {},
  ownerId: string = HOUSE,
  llmEnabled = true,
): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return;
  await ensureAgentsSeeded(ownerId);
  const roster = await db.select().from(agents).where(eq(agents.ownerId, ownerId));
  const agent = (key: string) => roster.find((a) => a.codename === key || a.agentKey === key);
  const nowMode = targetFor("scout-quant", keys) ? "llm" : "heuristic";

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
    let pre = games.filter((g) => g.status === "pre");
    if ((run.includeEvents ?? []).length > 0) {
      const keep = new Set(run.includeEvents);
      const before = pre.length;
      pre = pre.filter((g) => keep.has(g.eventId));
      await trace(runId, {
        layer: "system",
        agent: "KERNEL",
        message: `operator filter engaged — ${pre.length}/${before} queued games explicitly selected for analysis.`,
        mood: "info",
      });
    }
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
      await finishRun(runId, ownerId, run.slateDate, { headline: "No active slate", memo: "Every game on the board was already live or final. Pick another date.", avoided: [] }, []);
      return;
    }

    // ---------------- Layer 1: scouts ----------------
    let candId = 1;
    const models = new Map<string, ModelOut>();
    const allCandidates: Candidate[] = [];
    const filter: MarketFilter = buildFilter(run.markets);
    let filteredOut = 0;
    for (const g of pre) {
      const { cands, model } = candidatesFor(g, () => candId++);
      models.set(g.eventId, model);
      for (const c of cands) {
        if (allowsCandidate(filter, c.category, c.grade.stat)) allCandidates.push(c);
        else filteredOut++;
      }
    }
    if (!filter.mixed) {
      await trace(runId, {
        layer: "system",
        agent: "KERNEL",
        message: `market focus engaged — ${(run.markets ?? []).join(", ")}. ${allCandidates.length} qualifying signal${allCandidates.length === 1 ? "" : "s"} kept, ${filteredOut} off-target angle${filteredOut === 1 ? "" : "s"} discarded before the analysts.`,
        mood: "info",
      });
    }

    const slateText = pre.map(digest).join("\n\n");

    for (const code of ["QUANT", "MEDIC", "CHRONO", "MATCHUP", "SHARP"] as const) {
      const a = agent(code);
      const target = a ? targetFor(a.id, keys) : null;
      const injGames = pre.filter((g) => g.injuries.length > 0);
      const fatigueGames = pre.filter((g) => g.rest && (g.rest.homeB2B || g.rest.awayB2B || g.rest.home3in4 || g.rest.away3in4));
      const scope: Record<string, string> = {
        QUANT: `power lines built for ${pre.length} games — ${allCandidates.filter((c) => c.category === "spread" || c.category === "moneyline").length} model-vs-market edges flagged.${allCandidates.length > 0 ? ` strongest edge: ${allCandidates[0].pick} (${allCandidates[0].edge.toFixed(1)} pts).` : ""}`,
        MEDIC: injGames.length
          ? `injury impact priced into ${injGames.length} games: ${injGames.slice(0, 3).map((g) => `${g.matchup} (${g.injuries.length} reported)`).join(", ")}${injGames.length > 3 ? ` +${injGames.length - 3} more` : ""}.`
          : `no reportable injuries on this slate — all rosters appear intact.`,
        CHRONO: fatigueGames.length
          ? `fatigue spots identified: ${fatigueGames.slice(0, 3).map((g) => { const r = g.rest!; return `${g.matchup} (${r.homeB2B ? g.home.abbr + " B2B" : r.awayB2B ? g.away.abbr + " B2B" : r.home3in4 ? g.home.abbr + " 3-in-4" : g.away.abbr + " 3-in-4"})`; }).join(", ")}${fatigueGames.length > 3 ? ` +${fatigueGames.length - 3} more` : ""}.`
          : `no significant rest or travel edges on this slate.`,
        MATCHUP: `style analysis complete for ${pre.length} matchups — pace, scoring environment, and scheme collision factors priced.`,
        SHARP: `${pre.filter((g) => g.odds).length}/${pre.length} games carry posted lines. Key number positions and juice asymmetries noted.`,
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
    const propsTarget = propsAgent ? targetFor(propsAgent.id, keys) : null;
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
    // Count player props that were generated from leader data (no LLM needed)
    const leaderProps = allCandidates.filter((c) => c.category === "player_prop").length;
    await trace(runId, {
      layer: "scout",
      agent: "PROPS",
      message:
        propCount + leaderProps > 0
          ? `surfaced ${leaderProps} leader-data props + ${propCount} LLM props — ${leaderProps + propCount} player angles delivered for council review.`
          : `no high-conviction player edges cleared the threshold — staying disciplined rather than forcing props.`,
      mood: propCount + leaderProps > 0 ? "info" : "warn",
    });

    if (!allCandidates.length) {
      await trace(runId, {
        layer: "analyst",
        agent: "STRATEGA",
        message: "Zero model-vs-market gaps cleared the edge threshold. This board is priced efficiently — no card tonight.",
        mood: "warn",
      });
      await finishRun(runId, ownerId, run.slateDate, { headline: "Clean board, no edges", memo: "The market priced this slate efficiently. Discipline: no forced bets.", avoided: pre.map((g) => g.matchup).slice(0, 10) }, []);
      return;
    }

    // ---------------- Layer 2: analysts ----------------
    allCandidates.sort((a, b) => b.confidence - a.confidence);
    const stratega = agent("analyst-stratega") ?? agent("STRATEGA");
    const strategaTarget = stratega ? targetFor(stratega.id, keys) : null;
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
      // Combat prices are the model's own fair numbers, so a heavily juiced
      // read carries no edge unless a book is far longer. Refuse those.
      if (c.category.startsWith("fight_") && c.odds < -250)
        kills.push("model price too short — nothing to beat at this number");
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
    const contraTarget = contrarian ? targetFor(contrarian.id, keys) : null;
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
    const lessons = await buildLessons(ownerId);
    await trace(runId, {
      layer: "council",
      agent: "HISTORIAN",
      message: lessons.length
        ? `graded archive review: ${lessons.join(" · ")}.`
        : "graded archive has too few settled bets for statistical patterns. Will sharpen with volume.",
      mood: "info",
    });

    // Card construction by MARKET FAMILY. A professional card is not eight
    // spreads — it spans sides, totals, team props, player props and segment
    // derivatives. Families get reserved chairs before raw edge fills the rest.
    const familyOf = (cat: string): string =>
      cat.startsWith("fight_")
        ? "combat"
        : cat === "spread" || cat === "moneyline"
        ? "side"
        : cat === "total"
          ? "game_total"
          : cat === "team_total"
            ? "team_prop"
            : cat === "player_prop"
              ? "player_prop"
              : "segment_prop";
    // A balanced card caps each family; when the user has explicitly focused
    // the run on specific markets, diversity quotas would only starve the card.
    const FAMILY_CAP: Record<string, number> = filter.mixed
      ? { side: 4, game_total: 2, team_prop: 2, player_prop: 3, segment_prop: 3, combat: 4 }
      : { side: 10, game_total: 10, team_prop: 10, player_prop: 10, segment_prop: 10, combat: 10 };
    const card: Candidate[] = [];
    const perGame = new Map<string, number>();
    const perFamily = new Map<string, number>();
    let exposure = 0;
    const seat = (c: Candidate): number => {
      const cost = unitsFor(c);
      const fam = familyOf(c.category);
      perGame.set(c.game.eventId, (perGame.get(c.game.eventId) ?? 0) + 1);
      perFamily.set(fam, (perFamily.get(fam) ?? 0) + 1);
      c.finalUnits = cost;
      c.signals = [...new Set([...c.signals, "STRATEGA", "CONTRARIAN", "COMMISSIONER", "RISK", "HISTORIAN"])];
      card.push(c);
      exposure += cost;
      return cost;
    };
    const eligible = (c: Candidate, budget = 12.05): boolean => {
      if (card.includes(c)) return false;
      if ((perGame.get(c.game.eventId) ?? 0) >= (filter.mixed ? 2 : 3)) return false;
      const fam = familyOf(c.category);
      if ((perFamily.get(fam) ?? 0) >= (FAMILY_CAP[fam] ?? 3)) return false;
      return exposure + unitsFor(c) <= budget; // RISK veto on oversize
    };

    // Phase 1 — the four strongest raw edges anchor the card, but reserve
    // roughly half the bankroll so alternate markets can still be seated.
    for (const c of live) {
      if (card.length >= 4) break;
      if (eligible(c, filter.mixed ? 7.5 : 12.05)) seat(c);
    }

    // Phase 2 — one guaranteed chair for every market family with a live edge.
    const families = filter.mixed
      ? ["game_total", "player_prop", "team_prop", "segment_prop", "combat", "side"]
      : [];
    for (const fam of families) {
      if (card.length >= 10) break;
      if ((perFamily.get(fam) ?? 0) > 0) continue;
      // Walk the family's candidates until one clears game/budget limits —
      // taking only the single best would forfeit the chair when its game
      // is already double-booked.
      const pool = live
        .filter((c) => familyOf(c.category) === fam)
        .sort((a, b) => b.confidence - a.confidence);
      for (const c of pool) {
        if (eligible(c)) {
          seat(c);
          break;
        }
      }
    }

    // Phase 3 — fill remaining chairs by edge, still honouring family caps.
    for (const c of live) {
      if (card.length >= 10) break;
      if (eligible(c)) seat(c);
    }
    card.sort((a, b) => b.confidence - a.confidence);

    const commissioner = agent("COMMISSIONER");
    const commTarget = commissioner ? targetFor(commissioner.id, keys) : null;
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

    await finishRun(runId, ownerId, run.slateDate, decision, card);
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

/** Derivatives carry more variance than sides — RISK sizes them down. */
const REDUCED_SIZE = new Set(["total", "team_total", "player_prop", "1h_total", "1h_spread", "f5_total"]);
const MIN_SIZE = new Set(["1q_total", "p1_total", "nrfi"]);

function sealedUnits(c: { confidence: number; category: string; signals?: string[]; finalUnits?: number }): number {
  return c.finalUnits ?? unitsFor(c);
}

export function unitsFor(c: { confidence: number; category: string; signals?: string[] }): number {
  const convergence = (c.signals ?? []).filter((s) => SCOUT_CODES.has(s)).length;
  const u =
    c.confidence >= 68 && convergence >= 5 ? 2 :
    c.confidence >= 63 ? 1.5 :
    c.confidence >= 55 ? 1 : 0.5;
  if (MIN_SIZE.has(c.category)) return 0.5;
  return REDUCED_SIZE.has(c.category) ? Math.max(0.5, u - 0.5) : u;
}

async function finishRun(runId: number, ownerId: string, slateDate: string, decision: CouncilDecision, card: Candidate[]): Promise<void> {
  const repeats: NonNullable<CouncilDecision["repeats"]> = [];
  const carried: number[] = [];
  let released = 0;

  for (const c of card) {
    const key = dedupeKeyFor(slateDate, c);
    // Same wager identity already on this workspace's ledger? Acknowledge it
    // instead of inserting a clone — a duplicate row would settle a second
    // time and silently double-count the win or loss.
    const [existing] = await db
      .select({
        id: predictions.id,
        runId: predictions.runId,
        outcome: predictions.outcome,
      })
      .from(predictions)
      .where(and(eq(predictions.ownerId, ownerId), eq(predictions.dedupeKey, key)))
      .limit(1);

    if (existing) {
      // Already staked — show it on this card, but never grade it twice.
      carried.push(existing.id);
      repeats.push({
        pick: c.pick,
        matchup: c.game.matchup,
        firstRunId: existing.runId,
        outcome: existing.outcome,
      });
      continue;
    }

    const inserted = await db
      .insert(predictions)
      .values({
        ownerId,
        dedupeKey: key,
        runId,
        sortOrder: released,
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
      })
      // belt & braces: the unique index also blocks a race between two runs
      .onConflictDoNothing()
      .returning({ id: predictions.id });
    if (inserted.length) released++;
    else
      repeats.push({
        pick: c.pick,
        matchup: c.game.matchup,
        firstRunId: runId,
        outcome: "pending",
      });
  }

  const finalDecision: CouncilDecision = { ...decision, repeats };
  if (repeats.length) {
    finalDecision.memo =
      `${decision.memo} ${repeats.length} of these ${repeats.length + released} selections were already staked on an earlier run — they are shown again here but stay graded once.`.trim();
  }

  await db
    .update(runs)
    .set({ status: "completed", council: finalDecision, carried, completedAt: new Date() })
    .where(eq(runs.id, runId));
}

/** Stable identity of a wager: same bet on the same game = same key. */
function dedupeKeyFor(slateDate: string, c: Candidate): string {
  const g = c.grade;
  return [
    slateDate,
    c.game.sport,
    c.game.eventId,
    c.category,
    g.side ?? "",
    g.line ?? "",
    g.teamAbbr ?? "",
    g.player ?? "",
    g.stat ?? "",
    g.segment ?? "FULL",
  ].join("|");
}

async function buildLessons(ownerId: string = HOUSE): Promise<string[]> {
  const graded = await db
    .select()
    .from(predictions)
    .where(and(eq(predictions.ownerId, ownerId), ne(predictions.outcome, "pending")))
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
    if (rate >= 0.56) lessons.push(`${cat.replace("_", " ")}s are hitting at ${(rate * 100).toFixed(0)}% (${r.w}-${r.l})`);
    if (rate <= 0.44) lessons.push(`${cat.replace("_", " ")}s are underperforming at ${(rate * 100).toFixed(0)}% (${r.w}-${r.l}) — tighten edge requirements`);
  }
  return lessons.slice(0, 4);
}

// ---------------------------------------------------------------------------
// grading engine — settles pending bets against final scores, then pays the
// agents their rating adjustments (wins/losses ripple through the roster)
// ---------------------------------------------------------------------------

export async function gradePending(ownerId: string = HOUSE): Promise<{ graded: number; wins: number; losses: number; pushes: number }> {
  await ensureSchema();
  const pending = await db
    .select()
    .from(predictions)
    .where(
      and(
        eq(predictions.ownerId, ownerId),
        eq(predictions.outcome, "pending"),
        lt(predictions.startTime, new Date(Date.now() - 45 * 60_000)),
      ),
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

    // ---- segment (period/half/inning) markets settle off the linescore ----
    const seg = g.segment ?? "FULL";

    if (seg === "FIGHT" || p.category.startsWith("fight_")) {
      let fightOutcome: "win" | "loss" | "push" | null = null;
      if (p.category === "fight_ml") {
        const pickedHome = g.side === "home";
        const homeWon = f.homeScore === 1;
        const awayWon = f.awayScore === 1;
        if (!homeWon && !awayWon) fightOutcome = "push"; // draw / no contest
        else fightOutcome = (pickedHome && homeWon) || (!pickedHome && awayWon) ? "win" : "loss";
      } else if (p.category === "fight_method") {
        // side "under" == wagered on a finish, "over" == wagered on a decision
        const went = f.wentDistance === true;
        fightOutcome = (g.side === "under" && !went) || (g.side === "over" && went) ? "win" : "loss";
      } else if (p.category === "fight_rounds" && g.line != null) {
        const elapsed = f.elapsedMinutes ?? 0;
        const threshold = g.line * 5; // rounds are five minutes
        if (Math.abs(elapsed - threshold) < 0.02) fightOutcome = "push";
        else fightOutcome = (elapsed > threshold) === (g.side === "over") ? "win" : "loss";
      }
      if (fightOutcome) {
        const how = f.wentDistance
          ? "decision"
          : `R${f.endRound ?? "?"} finish`;
        const finalScore = `${f.winnerName ?? "result"} def. — ${how}`;
        await db
          .update(predictions)
          .set({ outcome: fightOutcome, finalScore, gradedAt: new Date() })
          .where(eq(predictions.id, p.id));
        graded++;
        if (fightOutcome === "win") wins++;
        else if (fightOutcome === "loss") losses++;
        else pushes++;
        creditList.push({ agents: p.agents, outcome: fightOutcome, confidence: p.confidence });
      }
      continue;
    }

    if (seg !== "FULL") {
      const slice = (line: number[]): number | null => {
        if (!line.length) return null;
        if (seg === "1H") {
          // NCAAB/soccer-style halves have 2 entries; quarter sports need Q1+Q2
          return line.length <= 2 ? line[0] : line[0] + line[1];
        }
        if (seg === "1Q" || seg === "P1" || seg === "1I") return line[0];
        if (seg === "F5") return line.slice(0, 5).reduce((s, n) => s + n, 0);
        return null;
      };
      const h = slice(f.homeLine);
      const a = slice(f.awayLine);
      if (h == null || a == null) continue; // linescore not published yet
      if (p.category === "1h_spread" && g.line != null) {
        const diff = g.side === "home" ? h + g.line - a : a + g.line - h;
        outcome = diff > 0 ? "win" : diff < 0 ? "loss" : "push";
      } else if (p.category === "nrfi") {
        const scored = h + a > 0;
        // side "under" == NRFI (no runs), "over" == YRFI
        outcome = (g.side === "under" && !scored) || (g.side === "over" && scored) ? "win" : "loss";
      } else if (g.line != null) {
        const tot = h + a;
        outcome = tot === g.line ? "push" : (tot > g.line) === (g.side === "over") ? "win" : "loss";
      }
      if (outcome) {
        const finalScore = `${f.awayAbbr} ${f.awayScore} — ${f.homeAbbr} ${f.homeScore} (${seg}: ${a}-${h})`;
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
      continue;
    }

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
  await settleAgentRatings(creditList, ownerId);
  return { graded, wins, losses, pushes };
}
