/**
 * Team-sport model.
 *
 * The old engine rated teams from season win-loss records, then bet whenever
 * that rating disagreed with the sportsbook. But the sportsbook is far better
 * informed than a W-L record, so a big disagreement almost always meant the
 * *model* was wrong — and the bigger the gap, the bigger the bet. That is how
 * you lose at a 53% hit rate.
 *
 * This model inverts the relationship:
 *   1. START from the book's own probability with the vig removed. That is the
 *      best available estimate of the truth.
 *   2. NUDGE it with situational adjustments (rest, confirmed injuries, ESPN's
 *      independent win projection), each heavily shrunk because the market has
 *      already priced most of what is public.
 *   3. Only call something a bet if the nudged probability still beats the vig
 *      at the price actually on offer, and enough independent signals agree.
 *
 * Most games will therefore be passes. That is the point: a pass is the
 * profitable decision whenever the number on the screen is fair.
 */

import type { GameInfo } from "./espn";
import type { BetCategory, GradeSpec } from "../db/schema";
import {
  clamp,
  devigTwoWay,
  evPerUnit,
  fairAmerican,
  impliedProb,
  minAcceptableAmerican,
  normInv,
  shiftProb,
} from "./edge";
import { bucketOf, fmtLine, fmtOdds, pct, type Candidate } from "./candidate";
import { allowsCandidate, type MarketFilter } from "./markets";

export interface SportParams {
  /** st. dev. of the final margin, in the sport's own units */
  sigmaMargin: number;
  /** st. dev. of the combined score */
  sigmaTotal: number;
  /** margin value of one confirmed-out rotation player */
  ptsPerOut: number;
  /** margin penalty for the tired side of a back-to-back */
  b2b: number;
  /** extra EV demanded because the public data for this sport is thinner */
  evBump: number;
  /** push probability on an integer spread */
  pushSpread: number;
  /** push probability on an integer total */
  pushTotal: number;
}

export const PARAMS: Record<string, SportParams> = {
  nba: { sigmaMargin: 12.0, sigmaTotal: 17.5, ptsPerOut: 1.5, b2b: 1.8, evBump: 0, pushSpread: 0.025, pushTotal: 0.02 },
  ncaab: { sigmaMargin: 10.5, sigmaTotal: 15.0, ptsPerOut: 1.4, b2b: 1.5, evBump: 0.01, pushSpread: 0.03, pushTotal: 0.025 },
  nfl: { sigmaMargin: 13.2, sigmaTotal: 10.5, ptsPerOut: 2.1, b2b: 2.0, evBump: 0, pushSpread: 0.03, pushTotal: 0.035 },
  ncaaf: { sigmaMargin: 15.5, sigmaTotal: 13.5, ptsPerOut: 2.1, b2b: 1.8, evBump: 0.01, pushSpread: 0.03, pushTotal: 0.025 },
  nhl: { sigmaMargin: 2.3, sigmaTotal: 2.3, ptsPerOut: 0.22, b2b: 0.28, evBump: 0.01, pushSpread: 0, pushTotal: 0.1 },
  mlb: { sigmaMargin: 4.3, sigmaTotal: 4.2, ptsPerOut: 0.28, b2b: 0.18, evBump: 0.005, pushSpread: 0, pushTotal: 0.09 },
};

/**
 * How much of each signal survives after the market has priced it.
 * Rest, injuries and ESPN's projection are all public, so books already
 * include most of them; only a fraction is left over as potential edge.
 */
export const SHRINK = { rest: 0.35, injury: 0.25, predictor: 0.2 };

/** Never lay more than this on a straight-up favourite. */
export const MAX_CHALK = -350;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "");

export function spreadPush(line: number, sport: string): number {
  if (!Number.isInteger(line)) return 0;
  const P = PARAMS[sport];
  if (!P) return 0;
  const a = Math.abs(line);
  if (sport === "nfl" || sport === "ncaaf") {
    if (a === 3) return 0.08;
    if (a === 7) return 0.06;
    if (a === 6 || a === 10) return 0.04;
  }
  return P.pushSpread;
}

export function totalPush(line: number, sport: string): number {
  return Number.isInteger(line) ? (PARAMS[sport]?.pushTotal ?? 0) : 0;
}

// ---------------------------------------------------------------------------
// situational adjustments (all in sport units, positive = favours HOME)
// ---------------------------------------------------------------------------

interface InjuryRead {
  pts: number;
  outs: number;
  stars: string[];
}

function injuryPts(g: GameInfo, abbr: string): InjuryRead {
  const P = PARAMS[g.sport];
  const mine = g.injuries.filter((i) => i.team.toUpperCase() === abbr.toUpperCase());
  const leaders = new Set(g.leaders.filter((l) => l.teamAbbr === abbr).map((l) => norm(l.athlete)));
  let weight = 0;
  let outs = 0;
  const stars: string[] = [];
  for (const inj of mine) {
    const s = inj.status.toLowerCase();
    let w = 0;
    if (s.includes("out") || s.includes("inactive") || s.includes("injured reserve")) {
      w = 1;
      outs++;
    } else if (s.includes("doubt")) w = 0.7;
    else if (s.includes("question") || s.includes("day-to-day") || s.includes("game time")) w = 0.3;
    if (!w) continue;
    // a team leader missing matters; a deep-bench name on the report barely does
    const isLeader = leaders.has(norm(inj.player));
    if (isLeader && w >= 0.7) stars.push(`${inj.player} (${inj.status})`);
    weight += w * (isLeader ? 1 : 0.45);
  }
  return { pts: Math.min(weight, 3) * (P?.ptsPerOut ?? 1), outs, stars };
}

function restPts(g: GameInfo): { pts: number; bits: string[] } {
  const P = PARAMS[g.sport];
  if (!g.rest || !P) return { pts: 0, bits: [] };
  const pen = P.b2b;
  const r = g.rest;
  const bits: string[] = [];
  let adj = 0;
  if (r.homeB2B && !r.awayB2B) {
    adj -= pen;
    bits.push(`${g.home.abbr} on a back-to-back`);
    if (r.homeTravel && r.awayDays >= 1) {
      adj -= pen / 3;
      bits.push("with travel");
    }
  }
  if (r.awayB2B && !r.homeB2B) {
    adj += pen;
    bits.push(`${g.away.abbr} on a back-to-back`);
    if (r.awayTravel && r.homeDays >= 1) {
      adj += pen / 3;
      bits.push("with travel");
    }
  }
  if (r.home3in4 && !r.away3in4 && !r.homeB2B) {
    adj -= pen * 0.5;
    bits.push(`${g.home.abbr} 3-in-4`);
  }
  if (r.away3in4 && !r.home3in4 && !r.awayB2B) {
    adj += pen * 0.5;
    bits.push(`${g.away.abbr} 3-in-4`);
  }
  if (r.homeDays >= 2 && r.awayDays === 0) adj += pen * 0.4;
  if (r.awayDays >= 2 && r.homeDays === 0) adj -= pen * 0.4;
  return { pts: adj, bits };
}

/** ESPN's own win projection, expressed as a margin gap vs the market. */
function predictorPts(g: GameInfo, sigma: number, pMlHome: number | null): number {
  const pr = g.context.predictor;
  if (!pr || pMlHome == null) return 0;
  const pPred = clamp(pr.homeWinPct / 100, 0.03, 0.97);
  const gap = (normInv(pPred) - normInv(clamp(pMlHome, 0.03, 0.97))) * sigma;
  return clamp(gap * SHRINK.predictor, -0.15 * sigma, 0.15 * sigma);
}

// ---------------------------------------------------------------------------
// the market, with the vig removed — and a sanity check on the data itself
// ---------------------------------------------------------------------------

export interface MarketView {
  pMlHome: number | null;
  /** probability the HOME side covers its posted spread */
  pSpreadHome: number | null;
  pOver: number | null;
  sharpOk: boolean;
  sharpNote: string;
}

export function marketView(g: GameInfo): MarketView {
  const o = g.odds;
  const view: MarketView = { pMlHome: null, pSpreadHome: null, pOver: null, sharpOk: true, sharpNote: "prices coherent" };
  if (!o) return { ...view, sharpOk: false, sharpNote: "no posted lines" };
  const problems: string[] = [];
  const book = (a: number, b: number) => impliedProb(a) + impliedProb(b);

  if (o.homeML != null && o.awayML != null) {
    const t = book(o.homeML, o.awayML);
    if (t < 1.0 || t > 1.15) problems.push(`moneylines imply ${(t * 100).toFixed(0)}%`);
    else view.pMlHome = devigTwoWay(o.homeML, o.awayML)[0];
  }
  if (o.homeSpread != null) {
    const ho = o.homeSpreadOdds ?? -110;
    const ao = o.awaySpreadOdds ?? -110;
    const t = book(ho, ao);
    if (t < 1.0 || t > 1.15) problems.push(`spread prices imply ${(t * 100).toFixed(0)}%`);
    else view.pSpreadHome = devigTwoWay(ho, ao)[0];
  }
  if (o.overUnder != null) {
    const ov = o.overOdds ?? -110;
    const un = o.underOdds ?? -110;
    const t = book(ov, un);
    if (t < 1.0 || t > 1.15) problems.push(`total prices imply ${(t * 100).toFixed(0)}%`);
    else view.pOver = devigTwoWay(ov, un)[0];
  }
  // spread and moneyline must agree on who the favourite is
  if (
    view.pMlHome != null &&
    o.homeSpread != null &&
    Math.abs(o.homeSpread) >= 2 &&
    g.sport !== "nhl" &&
    g.sport !== "mlb"
  ) {
    const spreadFavHome = o.homeSpread < 0;
    if (spreadFavHome !== view.pMlHome > 0.5) problems.push("spread and moneyline disagree on the favourite");
  }
  if (problems.length) {
    view.sharpOk = false;
    view.sharpNote = problems.join("; ");
  }
  return view;
}

// ---------------------------------------------------------------------------
// per-game intelligence (also what the LLM reviewers are shown)
// ---------------------------------------------------------------------------

export interface GameIntel {
  usable: boolean;
  /** why the game was passed on, when it was */
  reason?: string;
  restAdj: number;
  injAdj: number;
  predAdj: number;
  /** net margin shift (+ favours home) */
  dm: number;
  /** total shift */
  dt: number;
  market: MarketView;
  summary: string;
}

const signed = (x: number, d = 2): string => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;

export function readGame(g: GameInfo): GameIntel {
  const P = PARAMS[g.sport];
  const market = marketView(g);
  const empty = (reason: string): GameIntel => ({
    usable: false,
    reason,
    restAdj: 0,
    injAdj: 0,
    predAdj: 0,
    dm: 0,
    dt: 0,
    market,
    summary: `${g.matchup}: passed — ${reason}`,
  });
  if (!P) return empty("unsupported sport");
  if (!g.odds) return empty("no posted lines");
  if (!market.sharpOk) return empty(`suspect odds data (${market.sharpNote})`);
  if (!g.context.injuriesChecked)
    return empty("injury report not fetched — can't tell what the market already knows");

  const rest = restPts(g);
  const injH = injuryPts(g, g.home.abbr);
  const injA = injuryPts(g, g.away.abbr);
  const restAdj = rest.pts * SHRINK.rest;
  const injAdj = (injA.pts - injH.pts) * SHRINK.injury;
  const predAdj = predictorPts(g, P.sigmaMargin, market.pMlHome);
  const dm = restAdj + injAdj + predAdj;
  // missing scorers shave a little off the total; rest is not a total signal
  const dt = -0.6 * (injH.pts + injA.pts) * SHRINK.injury;

  const bits: string[] = [];
  if (rest.bits.length) bits.push(`rest ${signed(restAdj)} (${rest.bits.join(", ")})`);
  if (injH.outs + injA.outs > 0 || injH.stars.length + injA.stars.length > 0) {
    const stars = [...injH.stars, ...injA.stars];
    bits.push(
      `injuries ${signed(injAdj)} (${g.away.abbr} ${injA.outs} out / ${g.home.abbr} ${injH.outs} out${stars.length ? `; key: ${stars.slice(0, 2).join(", ")}` : ""})`,
    );
  }
  if (predAdj !== 0) bits.push(`ESPN projection ${signed(predAdj)}`);
  return {
    usable: true,
    restAdj,
    injAdj,
    predAdj,
    dm,
    dt,
    market,
    summary: `${g.matchup}: net ${signed(dm)} for ${g.home.abbr}${bits.length ? ` — ${bits.join("; ")}` : " — no situational edge"}`,
  };
}

// ---------------------------------------------------------------------------
// candidate construction
// ---------------------------------------------------------------------------

interface BuildArgs {
  g: GameInfo;
  nextId: () => number;
  category: BetCategory;
  pick: string;
  lineLabel: string;
  price: number;
  pWin: number;
  pPush: number;
  marketProb: number | null;
  priceSource: "book" | "model";
  trust: number;
  thesis: string;
  grade: GradeSpec;
  signals: string[];
  agree: number;
  /** model-priced picks only: the worst acceptable price */
  minOdds?: number | null;
}

function build(a: BuildArgs): Candidate {
  const cond = a.pWin / Math.max(1e-9, 1 - a.pPush);
  return {
    id: a.nextId(),
    game: a.g,
    category: a.category,
    pick: a.pick,
    lineLabel: a.lineLabel,
    odds: a.price,
    priceSource: a.priceSource,
    modelProb: a.pWin,
    pPush: a.pPush,
    marketProb: a.marketProb,
    fairOdds: fairAmerican(cond),
    minOdds: a.minOdds ?? null,
    ev: evPerUnit(a.pWin, a.price, a.pPush),
    trust: a.trust,
    signals: [...new Set(a.signals)],
    agree: a.agree,
    thesis: a.thesis,
    grade: a.grade,
    bucket: bucketOf(a.g.sport, a.category),
    cluster: clusterOf(a.category, a.grade),
    rank: evPerUnit(a.pWin, a.price, a.pPush) * 100 + 10 * (a.pWin - 0.5),
  };
}

/** Spread and moneyline on the same side are one bet, so they share a cluster. */
function clusterOf(category: BetCategory, grade: GradeSpec): string {
  if (category === "spread" || category === "moneyline") return "side";
  if (category === "total") return "total";
  if (category === "player_prop") return `prop:${grade.player ?? ""}:${grade.stat ?? ""}`;
  if (category === "team_total") return `tt:${grade.teamAbbr ?? ""}`;
  return `seg:${grade.segment ?? category}:${category}`;
}

const favors = (homePick: boolean, x: number): number => (homePick ? x : -x);

/** Which independent signals back a pick on the HOME (true) or AWAY side. */
function supporters(intel: GameIntel, homePick: boolean, sigma: number): string[] {
  const min = 0.03 * sigma;
  const out: string[] = [];
  if (favors(homePick, intel.predAdj) >= min) out.push("QUANT");
  if (favors(homePick, intel.injAdj) >= min) out.push("MEDIC");
  if (favors(homePick, intel.restAdj) >= min) out.push("CHRONO");
  return out;
}

const expertOf = (sport: string): string => `${sport.toUpperCase()}_EXPERT`;

/** SHARP backs a pick when the book charges little vig on that side. */
function priceQuality(price: number, fairSide: number | null): boolean {
  return fairSide != null && impliedProb(price) - fairSide <= 0.02;
}

export interface TeamEval {
  cands: Candidate[];
  intel: GameIntel;
  /** things we declined to do, for the council memo */
  skipped: string[];
}

const halfRound = (x: number): number => Math.round(x * 2) / 2;
const adjTxt = (intel: GameIntel): string => {
  const parts: string[] = [];
  if (intel.restAdj) parts.push(`rest ${signed(intel.restAdj)}`);
  if (intel.injAdj) parts.push(`injuries ${signed(intel.injAdj)}`);
  if (intel.predAdj) parts.push(`ESPN ${signed(intel.predAdj)}`);
  return parts.length ? parts.join(", ") : "no situational edge";
};

export function evaluateTeamGame(g: GameInfo, filter: MarketFilter, nextId: () => number): TeamEval {
  const intel = readGame(g);
  const skipped: string[] = [];
  const cands: Candidate[] = [];
  const P = PARAMS[g.sport];
  const o = g.odds;
  if (!intel.usable || !P || !o) {
    if (intel.reason) skipped.push(`${g.matchup}: ${intel.reason}`);
    return { cands, intel, skipped };
  }
  const sport = g.sport;
  const expert = expertOf(sport);

  // ---------------- spread ----------------
  if (o.homeSpread != null && allowsCandidate(filter, "spread")) {
    const line = o.homeSpread;
    const pc = shiftProb(intel.market.pSpreadHome ?? 0.5, intel.dm, P.sigmaMargin);
    const pushP = spreadPush(Math.abs(line), sport);
    const sides = (["home", "away"] as const).map((side) => {
      const cover = side === "home" ? pc : 1 - pc;
      const price = (side === "home" ? o.homeSpreadOdds : o.awaySpreadOdds) ?? -110;
      const pWin = cover * (1 - pushP);
      const mp = side === "home" ? intel.market.pSpreadHome : intel.market.pSpreadHome == null ? null : 1 - intel.market.pSpreadHome;
      return { side, price, pWin, mp, ev: evPerUnit(pWin, price, pushP) };
    });
    const best = sides.reduce((x, y) => (y.ev > x.ev ? y : x));
    const home = best.side === "home";
    const team = home ? g.home : g.away;
    const myLine = home ? line : -line;
    const sup = supporters(intel, home, P.sigmaMargin);
    const sharp = priceQuality(best.price, best.mp) ? ["SHARP"] : [];
    cands.push(
      build({
        g, nextId, category: "spread",
        pick: `${team.name} ${myLine > 0 ? "+" : ""}${Number(myLine.toFixed(1))}`,
        lineLabel: `spread ${myLine > 0 ? "+" : ""}${Number(myLine.toFixed(1))}`,
        price: best.price, pWin: best.pWin, pPush: pushP, marketProb: best.mp,
        priceSource: "book", trust: 1,
        thesis: `Book prices ${team.abbr} ${fmtLine(Number(myLine.toFixed(1)))} at ${fmtOdds(best.price)}${best.mp != null ? ` (${pct(best.mp)} to cover with the vig removed)` : ""}. Adjustments: ${adjTxt(intel)} → ${pct(best.pWin)} model.`,
        grade: { side: best.side, line: myLine },
        signals: [...sup, ...sharp, expert], agree: sup.length,
      }),
    );
  }

  // ---------------- moneyline ----------------
  if (o.homeML != null && o.awayML != null && intel.market.pMlHome != null && allowsCandidate(filter, "moneyline")) {
    const mlOk =
      sport !== "mlb" || (g.context.homeProbables.length > 0 && g.context.awayProbables.length > 0);
    if (!mlOk) {
      skipped.push(`${g.matchup}: moneyline skipped — starting pitchers not both posted`);
    } else {
      const pHome = shiftProb(intel.market.pMlHome, intel.dm, P.sigmaMargin);
      const sides = (["home", "away"] as const).map((side) => {
        const price = side === "home" ? o.homeML! : o.awayML!;
        const pWin = side === "home" ? pHome : 1 - pHome;
        const mp = side === "home" ? intel.market.pMlHome! : 1 - intel.market.pMlHome!;
        return { side, price, pWin, mp, ev: evPerUnit(pWin, price, 0) };
      });
      const eligible = sides.filter((s) => s.price >= MAX_CHALK);
      if (!eligible.length) {
        skipped.push(`${g.matchup}: moneyline skipped — both sides steeper than ${MAX_CHALK}`);
      } else {
        const best = eligible.reduce((x, y) => (y.ev > x.ev ? y : x));
        const home = best.side === "home";
        const team = home ? g.home : g.away;
        const sup = supporters(intel, home, P.sigmaMargin);
        const sharp = priceQuality(best.price, best.mp) ? ["SHARP"] : [];
        cands.push(
          build({
            g, nextId, category: "moneyline",
            pick: `${team.name} ML`,
            lineLabel: `ML ${fmtOdds(best.price)}`,
            price: best.price, pWin: best.pWin, pPush: 0, marketProb: best.mp,
            priceSource: "book", trust: 1,
            thesis: `Book prices ${team.abbr} at ${fmtOdds(best.price)} (${pct(best.mp)} with the vig removed). Adjustments: ${adjTxt(intel)} → ${pct(best.pWin)} model.`,
            grade: { side: best.side, line: null },
            signals: [...sup, ...sharp, expert], agree: sup.length,
          }),
        );
      }
    }
  }

  // ---------------- game total ----------------
  if (o.overUnder != null && allowsCandidate(filter, "total")) {
    const line = o.overUnder;
    const pushP = totalPush(line, sport);
    const pOverCond = shiftProb(intel.market.pOver ?? 0.5, intel.dt, P.sigmaTotal);
    const sides = (["over", "under"] as const).map((side) => {
      const c = side === "over" ? pOverCond : 1 - pOverCond;
      const price = (side === "over" ? o.overOdds : o.underOdds) ?? -110;
      const pWin = c * (1 - pushP);
      const mp = intel.market.pOver == null ? null : side === "over" ? intel.market.pOver : 1 - intel.market.pOver;
      return { side, price, pWin, mp, ev: evPerUnit(pWin, price, pushP) };
    });
    const best = sides.reduce((x, y) => (y.ev > x.ev ? y : x));
    const over = best.side === "over";
    // injuries are the only total signal we have; supports the under
    const medic = !over && intel.dt <= -0.03 * P.sigmaTotal ? ["MEDIC"] : [];
    const sharp = priceQuality(best.price, best.mp) ? ["SHARP"] : [];
    cands.push(
      build({
        g, nextId, category: "total",
        pick: `${over ? "Over" : "Under"} ${line} (${g.matchup})`,
        lineLabel: `${best.side} ${line}`,
        price: best.price, pWin: best.pWin, pPush: pushP, marketProb: best.mp,
        priceSource: "book", trust: 1,
        thesis: `Book total ${line} at ${fmtOdds(best.price)}${best.mp != null ? ` (${pct(best.mp)} with the vig removed)` : ""}. Scoring adjustments: ${intel.dt ? signed(intel.dt) + " from missing scorers" : "none that the market hasn't priced"} → ${pct(best.pWin)} model. Raw league-average mean-reversion is deliberately not used.`,
        grade: { side: best.side, line },
        signals: [...medic, ...sharp, expert], agree: medic.length,
      }),
    );
  }

  // ---------------- derived markets (explicit opt-in only) ----------------
  derivedCandidates(g, filter, nextId, intel, cands);

  return { cands, intel, skipped };
}

// ---------------------------------------------------------------------------
// derived markets: no posted line exists in the free feed, so these are OUR
// numbers. They are only produced on request and are always labelled as
// model-priced, with the line/price you must beat to play them.
// ---------------------------------------------------------------------------

const DERIVED_TRUST = 0.5;
const DERIVED_CUSHION = 0.03;

function modelPriced(
  g: GameInfo,
  nextId: () => number,
  category: BetCategory,
  a: {
    pick: string;
    lineLabel: string;
    pWin: number;
    stdPrice: number;
    grade: GradeSpec;
    thesis: string;
    signals: string[];
    agree: number;
    /** line the user must find: "over only at ≤ L" / "under only at ≥ L" */
    playRule: string;
  },
): Candidate {
  const minOdds = minAcceptableAmerican(a.pWin, DERIVED_CUSHION);
  return build({
    g, nextId, category,
    pick: a.pick, lineLabel: a.lineLabel,
    price: a.stdPrice, pWin: a.pWin, pPush: 0, marketProb: null,
    priceSource: "model", trust: DERIVED_TRUST,
    thesis: `${a.thesis} MODEL LINE — ESPN's free feed has no posted number for this market. ${a.playRule} Never pay worse than ${fmtOdds(minOdds)}.`,
    grade: a.grade, signals: a.signals, agree: a.agree, minOdds,
  });
}

function derivedCandidates(
  g: GameInfo,
  filter: MarketFilter,
  nextId: () => number,
  intel: GameIntel,
  out: Candidate[],
): void {
  const P = PARAMS[g.sport];
  const o = g.odds;
  if (!P || !o) return;
  const expert = expertOf(g.sport);
  const matchup = g.matchup;

  // ---- team totals ----
  if (allowsCandidate(filter, "team_total")) {
    for (const side of ["home", "away"] as const) {
      const tt = side === "home" ? o.homeTeamTotal : o.awayTeamTotal;
      if (tt == null) continue;
      const team = side === "home" ? g.home : g.away;
      const d = side === "home" ? intel.dt / 2 + intel.dm / 2 : intel.dt / 2 - intel.dm / 2;
      const pOver = shiftProb(0.5, d, P.sigmaTotal * 0.72);
      const over = pOver >= 0.5;
      const p = over ? pOver : 1 - pOver;
      const sup = supporters(intel, side === "home" ? over : !over, P.sigmaMargin);
      out.push(
        modelPriced(g, nextId, "team_total", {
          pick: `${team.name} team total ${over ? "over" : "under"} ${tt}`,
          lineLabel: `${over ? "o" : "u"}${tt}`,
          pWin: p, stdPrice: -110,
          grade: { side: over ? "team_over" : "team_under", line: tt, teamAbbr: team.abbr },
          thesis: `${team.abbr} team total ${tt} (${o.teamTotalsDerived ? "derived from spread + total" : "posted"}). Adjustments: ${adjTxt(intel)} → ${pct(p)} ${over ? "over" : "under"}.`,
          signals: [...sup, expert], agree: sup.length,
          playRule: over ? `Over only if your book's number is ${tt} or lower.` : `Under only if your book's number is ${tt} or higher.`,
        }),
      );
    }
  }

  const football = g.sport === "nfl" || g.sport === "ncaaf";
  const hoops = g.sport === "nba" || g.sport === "ncaab";

  // ---- first half / first quarter / first period / first five ----
  const totalLike = (
    category: BetCategory, share: number, segment: "1H" | "1Q" | "P1" | "F5",
    label: string, short: string, stdPrice: number,
  ) => {
    if (!allowsCandidate(filter, category) || o.overUnder == null) return;
    const line = Math.max(0.5, halfRound(o.overUnder * share));
    const pOver = shiftProb(0.5, intel.dt * share, P.sigmaTotal * Math.sqrt(share));
    const over = pOver >= 0.5;
    const p = over ? pOver : 1 - pOver;
    out.push(
      modelPriced(g, nextId, category, {
        pick: `${label} ${over ? "over" : "under"} ${line} (${matchup})`,
        lineLabel: `${short} ${over ? "o" : "u"}${line}`,
        pWin: p, stdPrice,
        grade: { side: over ? "over" : "under", line, segment },
        thesis: `${label} number ≈ ${line} (${(share * 100).toFixed(1)}% of the ${o.overUnder} game total). ${pct(p)} ${over ? "over" : "under"} after ${adjTxt(intel)}.`,
        signals: [expert], agree: 0,
        playRule: over ? `Over only if your book's number is ${line} or lower.` : `Under only if your book's number is ${line} or higher.`,
      }),
    );
  };
  if (football || hoops) {
    totalLike("1h_total", football ? 0.49 : 0.505, "1H", "1st half", "1H", -110);
    if (allowsCandidate(filter, "1h_spread") && o.homeSpread != null) {
      const share = football ? 0.55 : 0.52;
      const halfSpread = halfRound(o.homeSpread * share);
      const pHome = shiftProb(0.5, intel.dm * share, P.sigmaMargin * Math.sqrt(0.5));
      const home = pHome >= 0.5;
      const p = home ? pHome : 1 - pHome;
      const team = home ? g.home : g.away;
      const line = home ? halfSpread : -halfSpread;
      const sup = supporters(intel, home, P.sigmaMargin);
      out.push(
        modelPriced(g, nextId, "1h_spread", {
          pick: `${team.name} 1st half ${line > 0 ? "+" : ""}${line}`,
          lineLabel: `1H ${line > 0 ? "+" : ""}${line}`,
          pWin: p, stdPrice: -110,
          grade: { side: home ? "home" : "away", line, segment: "1H" },
          thesis: `1st-half spread ≈ ${fmtLine(halfSpread)} for ${g.home.abbr}. ${pct(p)} for ${team.abbr} after ${adjTxt(intel)}.`,
          signals: [...sup, expert], agree: sup.length,
          playRule: `Only if your book's number is ${fmtLine(line)} or better.`,
        }),
      );
    }
    if (g.sport !== "ncaab") totalLike("1q_total", football ? 0.235 : 0.253, "1Q", "1st quarter", "1Q", -115);
  }
  if (g.sport === "nhl") totalLike("p1_total", 0.315, "P1", "1st period", "P1", -115);
  if (g.sport === "mlb") totalLike("f5_total", 0.55, "F5", "First 5 innings", "F5", -115);

  // ---- player props ----
  // props are opt-in: only when at least one prop market was explicitly selected
  if (!filter.mixed && filter.categories.has("player_prop")) propCandidates(g, filter, nextId, intel, out);
}

// ---------------------------------------------------------------------------
// player props (opt-in, model-priced)
// ---------------------------------------------------------------------------

/**
 * Coefficient of variation and the median/mean ratio of a single-game stat.
 * Yardage is right-skewed: the median sits below the mean, so "over the
 * AVERAGE" loses more than half the time. We set the model line at the median
 * instead of the mean, which is what the old code got wrong.
 */
const PROP: Record<string, { cv: number; skew: number; need: number; label: string }> = {
  PASS_YDS: { cv: 0.3, skew: 0.98, need: 0.1, label: "pass yds" },
  RUSH_YDS: { cv: 0.6, skew: 0.9, need: 0.1, label: "rush yds" },
  REC_YDS: { cv: 0.7, skew: 0.88, need: 0.1, label: "rec yds" },
  PTS: { cv: 0.33, skew: 0.97, need: 0.1, label: "points" },
  REB: { cv: 0.45, skew: 0.95, need: 0.1, label: "rebounds" },
  AST: { cv: 0.5, skew: 0.95, need: 0.1, label: "assists" },
};

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

function propCandidates(
  g: GameInfo,
  filter: MarketFilter,
  nextId: () => number,
  intel: GameIntel,
  out: Candidate[],
): void {
  const o = g.odds;
  const P = PARAMS[g.sport];
  if (!o || !P) return;
  const spread = o.homeSpread ?? 0;
  for (const L of g.leaders) {
    if (L.perGame == null || !L.teamAbbr) continue;
    if (!allowsCandidate(filter, "player_prop", L.stat)) continue;
    const isHome = L.teamAbbr === g.home.abbr;
    const favMargin = isHome ? -spread : spread; // + means this team is favoured
    const sup: string[] = [];

    // ----- touchdown markets: counts, not lines -----
    if (L.stat === "ANY_TD" || L.stat === "PASS_TD") {
      const lambda = Math.max(0.05, L.perGame * (1 + favMargin * 0.011)); // half the old script effect
      if (L.stat === "ANY_TD") {
        const p = 1 - Math.exp(-lambda);
        if (p < 0.55 || p > 0.78) continue;
        const fair = fairAmerican(p);
        const minOdds = minAcceptableAmerican(p, DERIVED_CUSHION);
        out.push(
          build({
            g, nextId, category: "player_prop",
            pick: `${L.athlete} anytime touchdown`, lineLabel: "anytime TD",
            price: minOdds, pWin: p, pPush: 0, marketProb: null,
            priceSource: "model", trust: DERIVED_TRUST,
            thesis: `${L.athlete} (${L.teamAbbr}) scores ${L.perGame}/game; ${favMargin > 0 ? "favourite" : "underdog"} script → ${pct(p)}, fair ${fmtOdds(fair)}. MODEL PRICE — shop it: never pay worse than ${fmtOdds(minOdds)}.`,
            grade: { side: "team_over", line: 0.5, player: L.athlete, stat: "ANY_TD", teamAbbr: L.teamAbbr },
            signals: ["PROPS", expertOf(g.sport)], agree: 0, minOdds,
          }),
        );
      } else {
        const lineTd = lambda >= 1.9 ? 1.5 : 0.5;
        const pOver = 1 - poissonCdf(lineTd, lambda);
        const over = pOver >= 0.5;
        const p = over ? pOver : 1 - pOver;
        if (p < 0.58) continue;
        out.push(
          modelPriced(g, nextId, "player_prop", {
            pick: `${L.athlete} ${over ? "over" : "under"} ${lineTd} passing TDs`,
            lineLabel: `${over ? "o" : "u"}${lineTd} pass TD`,
            pWin: p, stdPrice: -115,
            grade: { side: over ? "team_over" : "team_under", line: lineTd, player: L.athlete, stat: "PASS_TD", teamAbbr: L.teamAbbr },
            thesis: `${L.athlete} averages ${L.perGame} passing TD/game → ${lambda.toFixed(2)} expected here; ${pct(p)} ${over ? "over" : "under"} ${lineTd}.`,
            signals: ["PROPS", expertOf(g.sport)], agree: 0,
            playRule: over ? `Over only if your book's number is ${lineTd} or lower.` : `Under only if your book's number is ${lineTd} or higher.`,
          }),
        );
      }
      continue;
    }

    // ----- yardage / box-score lines -----
    const M = PROP[L.stat];
    if (!M) continue;
    let adj = 0;
    if (L.stat === "RUSH_YDS") adj = favMargin * 1.4;
    else if (L.stat === "PASS_YDS") adj = -favMargin * 3.0;
    else if (L.stat === "REC_YDS") adj = -favMargin * 1.1;
    else {
      const outs = g.injuries.filter((i) => i.team === L.teamAbbr && /out|doubt/i.test(i.status)).length;
      adj = outs * (L.stat === "PTS" ? 2.2 : 0.8);
    }
    if (g.rest && (isHome ? g.rest.homeB2B : g.rest.awayB2B)) adj -= L.perGame * 0.04;
    adj *= 0.5; // the market has already moved the player's number for this
    const sigma = Math.max(0.5, M.cv * L.perGame);
    const pOver = shiftProb(0.5, adj, sigma);
    const over = pOver >= 0.5;
    const p = over ? pOver : 1 - pOver;
    if (p < 0.58) continue;
    const line = Math.max(0.5, Math.floor(L.perGame * M.skew) + 0.5);
    if (L.stat === "PTS" || L.stat === "REB" || L.stat === "AST") sup.push("MEDIC");
    out.push(
      modelPriced(g, nextId, "player_prop", {
        pick: `${L.athlete} ${over ? "over" : "under"} ${line} ${M.label}`,
        lineLabel: `${over ? "o" : "u"}${line}`,
        pWin: p, stdPrice: -110,
        grade: { side: over ? "team_over" : "team_under", line, player: L.athlete, stat: L.stat, teamAbbr: L.teamAbbr },
        thesis: `${L.athlete} (${L.teamAbbr}${L.position ? `, ${L.position}` : ""}) averages ${L.perGame} ${M.label}; median ≈ ${line}. Game script as ${favMargin > 0 ? "a favourite" : "an underdog"} moves it ${signed(adj, 1)} → ${pct(p)} ${over ? "over" : "under"}.`,
        signals: ["PROPS", ...sup, expertOf(g.sport)], agree: sup.length ? 1 : 0,
        playRule: over ? `Over only if your book's number is ${line} or lower.` : `Under only if your book's number is ${line} or higher.`,
      }),
    );
  }
}
