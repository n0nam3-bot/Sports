/**
 * MMA joint outcome model.
 *
 * Instead of pricing each market on its own (which produces contradictions
 * such as "72% to finish" next to "over 2.5 rounds at 65%"), we model ONE joint
 * distribution over  who wins × how it ends × when it ends,  then derive every
 * market — moneyline, total rounds, goes the distance, fight to start round N,
 * method of victory, the finish handicap, significant strikes and takedowns —
 * from it. All markets therefore agree with each other by construction.
 *
 * Pure module: no I/O. Fighter inputs come from ESPN's career stats when we
 * have them and degrade gracefully to records + division base rates.
 */

import { clamp, fairAmerican } from "./edge";
import { fighterStrength } from "./combat";
import type { FighterProfile } from "./fighter-stats";

export type Promotion = "ufc" | "dwcs" | "pfl";
export type Side = "home" | "away";
export type Method = "ko" | "sub" | "dec";

export interface MmaFighterInput {
  record: string;
  profile: FighterProfile | null;
}

export interface MmaBoutInput {
  weightClass: string;
  scheduledRounds: number;
  promotion: Promotion;
  /** first-listed fighter (the app's "away" slot) */
  away: MmaFighterInput;
  /** second-listed fighter (the app's "home" slot) */
  home: MmaFighterInput;
}

export interface MethodShares {
  ko: number;
  sub: number;
  dec: number;
}

export interface Scenario {
  minutes: number;
  prob: number;
}

export interface MmaModel {
  rounds: number;
  pAway: number;
  pHome: number;
  pFinish: number;
  pDecision: number;
  /** P(fight ends inside round r+1); index 0 is round 1. Sums to pFinish. */
  finishByRound: number[];
  /** P(this fighter wins by this method); each side sums to that side's win prob */
  method: Record<Side, MethodShares>;
  /** duration scenarios used by the strikes / takedown models */
  scenarios: Scenario[];
  expectedMinutes: number;
  /** career rates used for the volume props */
  rates: Record<Side, { sigPerMin: number; tdPer15: number; oppStrikeDef: number; oppTdDef: number }>;
  /** same bout with only the division/promotion base rates (the "line-setter") */
  baselineMinutes: number;
  statsUsed: boolean;
}

// ---------------------------------------------------------------------------
// division base rates
// ---------------------------------------------------------------------------

/** [KO/TKO, submission, decision] share of fights, by division. */
const PRIOR: Record<string, [number, number, number]> = {
  hw: [0.5, 0.13, 0.37],
  lhw: [0.45, 0.12, 0.43],
  mw: [0.41, 0.12, 0.47],
  ww: [0.36, 0.13, 0.51],
  lw: [0.33, 0.16, 0.51],
  fw: [0.29, 0.15, 0.56],
  bw: [0.27, 0.15, 0.58],
  flw: [0.22, 0.16, 0.62],
  straw: [0.16, 0.15, 0.69],
  w_bw: [0.22, 0.15, 0.63],
  w_flw: [0.2, 0.15, 0.65],
  w_fw: [0.2, 0.14, 0.66],
  default: [0.35, 0.14, 0.51],
};

export function classKey(weightClass: string): string {
  const w = weightClass.toLowerCase();
  const women = /women|wom\.|\bw\b/.test(w);
  if (/straw/.test(w)) return "straw";
  if (/light\s*heavy|\blhw\b/.test(w)) return "lhw";
  if (/heavy|\bhw\b/.test(w)) return "hw";
  if (/middle|\bmw\b/.test(w)) return "mw";
  if (/welter|\bww\b/.test(w)) return "ww";
  if (/light|\blw\b/.test(w)) return "lw";
  if (/feather|\bfw\b/.test(w)) return women ? "w_fw" : "fw";
  if (/bantam|\bbw\b/.test(w)) return women ? "w_bw" : "bw";
  if (/fly|\bflw\b/.test(w)) return women ? "w_flw" : "flw";
  return "default";
}

const AVG_SIG_PER_MIN = 3.4;
const AVG_TD_PER_15 = 0.9;
const AVG_STRIKE_DEF = 55;
const AVG_TD_DEF = 62;

// ---------------------------------------------------------------------------
// who wins
// ---------------------------------------------------------------------------

function hasStats(p: FighterProfile | null): p is FighterProfile {
  return !!p && p.hasStats === true;
}

/** How much an opponent's defence inflates / deflates what we expect to land. */
function strikeDefFactor(oppDef: number): number {
  return clamp(1 + (AVG_STRIKE_DEF - oppDef) / 100 * 1.2, 0.7, 1.3);
}
function tdDefFactor(oppDef: number): number {
  return clamp((100 - oppDef) / (100 - AVG_TD_DEF), 0.35, 1.8);
}

function winProb(away: MmaFighterInput, home: MmaFighterInput): { pHome: number; statsUsed: boolean } {
  const A = fighterStrength(away.record);
  const B = fighterStrength(home.record);
  const expEdge = clamp((B.fights - A.fights) * 0.004, -0.05, 0.05);
  const pRec = 0.5 + (B.pct - A.pct) * 1.3 + expEdge;

  const ap = away.profile;
  const hp = home.profile;
  const statsUsed = hasStats(ap) && hasStats(hp);
  let p = pRec;
  if (statsUsed && ap && hp) {
    const landA = ap.strikeLPM * strikeDefFactor(hp.strikeDefense);
    const landB = hp.strikeLPM * strikeDefFactor(ap.strikeDefense);
    const strk = (landB - landA) / Math.max(1, landA + landB);
    const tdA = ap.takedownAvg * tdDefFactor(hp.takedownDefense);
    const tdB = hp.takedownAvg * tdDefFactor(ap.takedownDefense);
    const td = (tdB - tdA) / Math.max(0.5, tdA + tdB);
    const pStat = 0.5 + strk * 0.35 + td * 0.15;
    p = 0.5 + 0.55 * (pRec - 0.5) + 0.45 * (pStat - 0.5);
  }
  // MMA markets are sharp and our inputs are thin: never claim more than 78/22.
  p = 0.5 + 0.85 * (p - 0.5);
  return { pHome: clamp(p, 0.22, 0.78), statsUsed };
}

// ---------------------------------------------------------------------------
// how it ends
// ---------------------------------------------------------------------------

function tendencies(p: FighterProfile | null): { ko: number; sub: number; dec: number } {
  if (!hasStats(p)) return { ko: 1, sub: 1, dec: 1 };
  return {
    ko: clamp((p.koTkoPct + 10) / 45, 0.55, 1.9),
    sub: clamp((p.submissionAvg + 0.15) / 0.65, 0.5, 2.2),
    dec: clamp((p.decisionPct + 10) / 40, 0.55, 1.8),
  };
}

/** If `winner` wins, how does it end? Shrunk toward the division base rate. */
function methodShares(
  winner: MmaFighterInput,
  loser: MmaFighterInput,
  prior: [number, number, number],
): MethodShares {
  const t = tendencies(winner.profile);
  const lp = loser.profile;
  const qKo = hasStats(lp) ? clamp(1 + (AVG_STRIKE_DEF - lp.strikeDefense) / 100 * 1.5, 0.75, 1.3) : 1;
  const qSub = hasStats(lp) ? clamp(1 + (AVG_TD_DEF - lp.takedownDefense) / 100 * 1.5, 0.7, 1.4) : 1;
  const ko = prior[0] * t.ko * qKo;
  const sub = prior[1] * t.sub * qSub;
  const dec = prior[2] * t.dec;
  const total = ko + sub + dec;
  return { ko: ko / total, sub: sub / total, dec: dec / total };
}

function scaleFinish(s: MethodShares, scale: number): void {
  let ko = s.ko * scale;
  let sub = s.sub * scale;
  const fin = ko + sub;
  if (fin > 0.97) {
    ko *= 0.97 / fin;
    sub *= 0.97 / fin;
  }
  s.ko = ko;
  s.sub = sub;
  s.dec = 1 - ko - sub;
}

// ---------------------------------------------------------------------------
// when it ends
// ---------------------------------------------------------------------------

/** Share of finishes that land in each round. */
export function finishRoundWeights(rounds: number, key: string, promotion: Promotion): number[] {
  const base =
    rounds >= 5
      ? [0.33, 0.26, 0.2, 0.12, 0.09]
      : rounds === 3
        ? [0.43, 0.32, 0.25]
        : rounds === 2
          ? [0.55, 0.45]
          : Array.from({ length: rounds }, (_, i) => 0.76 ** i);
  const w = base.slice(0, rounds);
  const early = key === "hw" || key === "lhw" ? 1.12 : key === "flw" || key === "straw" ? 0.92 : 1;
  w[0] *= early * (promotion === "dwcs" ? 1.08 : 1);
  const total = w.reduce((s, x) => s + x, 0);
  return w.map((x) => x / total);
}

/** Probability a stoppage in round r happens before the round's midpoint. */
const firstHalfShare = (round: number): number => (round === 1 ? 0.55 : 0.5);

/** Average minute at which a round-r finish happens. */
const minutesAtFinish = (round: number): number => 5 * (round - 1) + (round === 1 ? 2.3 : 2.5);

function buildScenarios(rounds: number, finishByRound: number[], pDecision: number): Scenario[] {
  const out: Scenario[] = finishByRound.map((prob, i) => ({ minutes: minutesAtFinish(i + 1), prob }));
  out.push({ minutes: 5 * rounds, prob: pDecision });
  return out;
}

const expectedOf = (s: Scenario[]): number => s.reduce((t, x) => t + x.prob * x.minutes, 0);

// ---------------------------------------------------------------------------
// the model
// ---------------------------------------------------------------------------

export function buildMmaModel(inp: MmaBoutInput): MmaModel {
  const rounds = Math.max(1, Math.min(5, Math.round(inp.scheduledRounds) || 3));
  const key = classKey(inp.weightClass);
  const prior = PRIOR[key] ?? PRIOR.default;
  const { pHome, statsUsed } = winProb(inp.away, inp.home);
  const pAway = 1 - pHome;

  const sAway = methodShares(inp.away, inp.home, prior);
  const sHome = methodShares(inp.home, inp.away, prior);
  const fin0 = pAway * (sAway.ko + sAway.sub) + pHome * (sHome.ko + sHome.sub);

  // promotion + format adjustments move finish probability, not the winner
  const boost = inp.promotion === "dwcs" ? 0.07 : 0;
  const target = clamp(fin0 + boost - (rounds >= 5 ? 0.04 : 0), 0.2, 0.82);
  const scale = fin0 > 0 ? target / fin0 : 1;
  scaleFinish(sAway, scale);
  scaleFinish(sHome, scale);

  const pFinish = pAway * (sAway.ko + sAway.sub) + pHome * (sHome.ko + sHome.sub);
  const pDecision = 1 - pFinish;
  const w = finishRoundWeights(rounds, key, inp.promotion);
  const finishByRound = w.map((x) => x * pFinish);
  const scenarios = buildScenarios(rounds, finishByRound, pDecision);

  // the "line-setter": what a book would assume with no fighter-specific info
  const baseFinish = clamp(prior[0] + prior[1] + boost - (rounds >= 5 ? 0.04 : 0), 0.2, 0.82);
  const baseScen = buildScenarios(
    rounds,
    w.map((x) => x * baseFinish),
    1 - baseFinish,
  );

  const rate = (me: FighterProfile | null, opp: FighterProfile | null) => ({
    sigPerMin: hasStats(me) ? clamp(me.strikeLPM, 0.8, 9) : AVG_SIG_PER_MIN,
    tdPer15: hasStats(me) ? clamp(me.takedownAvg, 0, 8) : AVG_TD_PER_15,
    oppStrikeDef: hasStats(opp) ? opp.strikeDefense : AVG_STRIKE_DEF,
    oppTdDef: hasStats(opp) ? opp.takedownDefense : AVG_TD_DEF,
  });

  return {
    rounds,
    pAway,
    pHome,
    pFinish,
    pDecision,
    finishByRound,
    method: {
      away: { ko: pAway * sAway.ko, sub: pAway * sAway.sub, dec: pAway * sAway.dec },
      home: { ko: pHome * sHome.ko, sub: pHome * sHome.sub, dec: pHome * sHome.dec },
    },
    scenarios,
    expectedMinutes: expectedOf(scenarios),
    rates: {
      away: rate(inp.away.profile, inp.home.profile),
      home: rate(inp.home.profile, inp.away.profile),
    },
    baselineMinutes: expectedOf(baseScen),
    statsUsed,
  };
}

// ---------------------------------------------------------------------------
// market probabilities (all derived from the same model)
// ---------------------------------------------------------------------------

export const opp = (s: Side): Side => (s === "home" ? "away" : "home");

/** P(the fight reaches the start of round k). reach(1) = 1. */
export function pReach(m: MmaModel, k: number): number {
  if (k <= 1) return 1;
  if (k > m.rounds) return 0;
  let ended = 0;
  for (let r = 1; r < k; r++) ended += m.finishByRound[r - 1] ?? 0;
  return clamp(1 - ended, 0, 1);
}

/** Total-rounds lines a 'rounds'-round bout can sensibly offer: 0.5 … rounds-0.5. */
export function roundLines(rounds: number): number[] {
  return Array.from({ length: rounds }, (_, i) => i + 0.5);
}

/**
 * P(total rounds goes OVER the line). A line L=k-0.5 is cleared once the fight
 * survives past the midpoint of round k.
 */
export function pRoundsOver(m: MmaModel, line: number): number {
  const k = Math.round(line + 0.5);
  if (k < 1 || k > m.rounds) return NaN;
  return clamp(pReach(m, k) - (m.finishByRound[k - 1] ?? 0) * firstHalfShare(k), 0, 1);
}

export const pGoesDistance = (m: MmaModel): number => m.pDecision;

/** P(fighter wins by this method). */
export const pMethod = (m: MmaModel, side: Side, method: Method): number => m.method[side][method];

/** P(side wins by KO/TKO or submission). */
export const pWinByFinish = (m: MmaModel, side: Side): number =>
  m.method[side].ko + m.method[side].sub;

/**
 * Finish handicap. "-1.5" must win inside the distance; "+1.5" covers unless
 * the opponent finishes the fight.
 */
export function pFinishSpread(m: MmaModel, side: Side, line: -1.5 | 1.5): number {
  return line === -1.5 ? pWinByFinish(m, side) : clamp(1 - pWinByFinish(m, opp(side)), 0, 1);
}

// ---------- count distributions for the volume props ----------

/** P(X <= x) for a negative binomial with the given mean and size k. */
export function negBinCdf(x: number, mean: number, k: number): number {
  if (x < 0) return 0;
  if (!(mean > 0)) return 1;
  const r = mean / (k + mean);
  let pmf = Math.pow(k / (k + mean), k);
  let cdf = pmf;
  for (let n = 0; n < Math.floor(x); n++) {
    pmf *= ((n + k) / (n + 1)) * r;
    cdf += pmf;
    if (pmf < 1e-14 && n > mean) break;
  }
  return clamp(cdf, 0, 1);
}

const SIG_DISPERSION = 6; // per-fight CV of landed strikes at fixed duration ≈ 0.43
const TD_DISPERSION = 2.5; // takedowns are lumpy

function sigMeanPerMin(m: MmaModel, side: Side): number {
  const r = m.rates[side];
  return r.sigPerMin * strikeDefFactor(r.oppStrikeDef);
}
function tdMeanPer15(m: MmaModel, side: Side): number {
  const r = m.rates[side];
  return r.tdPer15 * tdDefFactor(r.oppTdDef);
}

export const sigStrikesMean = (m: MmaModel, side: Side): number =>
  sigMeanPerMin(m, side) * m.expectedMinutes;
export const takedownsMean = (m: MmaModel, side: Side): number =>
  (tdMeanPer15(m, side) / 15) * m.expectedMinutes;

/** What a book would set with no matchup information: raw career rate × typical minutes. */
export const sigStrikesBaseline = (m: MmaModel, side: Side): number =>
  m.rates[side].sigPerMin * m.baselineMinutes;
export const takedownsBaseline = (m: MmaModel, side: Side): number =>
  (m.rates[side].tdPer15 / 15) * m.baselineMinutes;

/** A half-point line near x, so a push is impossible. */
export const halfLine = (x: number): number => Math.max(0.5, Math.floor(x) + 0.5);

function pCountOver(
  m: MmaModel,
  ratePerMin: number,
  dispersion: number,
  line: number,
): number {
  const need = Math.floor(line); // count must exceed `line`, i.e. be > floor(line)
  let p = 0;
  for (const s of m.scenarios) {
    if (s.prob <= 0) continue;
    p += s.prob * (1 - negBinCdf(need, ratePerMin * s.minutes, dispersion));
  }
  return clamp(p, 0, 1);
}

export const pSigStrikesOver = (m: MmaModel, side: Side, line: number): number =>
  pCountOver(m, sigMeanPerMin(m, side), SIG_DISPERSION, line);

export const pTakedownsOver = (m: MmaModel, side: Side, line: number): number =>
  pCountOver(m, tdMeanPer15(m, side) / 15, TD_DISPERSION, line);

// ---------------------------------------------------------------------------
// legacy shape for the slate board
// ---------------------------------------------------------------------------

export interface LegacyCombat {
  pHome: number;
  pAway: number;
  fairHomeML: number;
  fairAwayML: number;
  pFinish: number;
  fairFinish: number;
  fairDecision: number;
  expRounds: number;
  roundLine: number;
  pRoundsOver: number;
  fairRoundsOver: number;
  fairRoundsUnder: number;
}

export function legacyFromModel(m: MmaModel): LegacyCombat {
  const roundLine = m.rounds >= 5 ? 2.5 : Math.min(1.5, m.rounds - 0.5);
  const over = pRoundsOver(m, roundLine);
  const pOver = Number.isFinite(over) ? over : 0.5;
  const expRounds = m.expectedMinutes / 5;
  return {
    pHome: m.pHome,
    pAway: m.pAway,
    fairHomeML: fairAmerican(m.pHome),
    fairAwayML: fairAmerican(m.pAway),
    pFinish: m.pFinish,
    fairFinish: fairAmerican(m.pFinish),
    fairDecision: fairAmerican(m.pDecision),
    expRounds: Math.round(expRounds * 100) / 100,
    roundLine,
    pRoundsOver: pOver,
    fairRoundsOver: fairAmerican(pOver),
    fairRoundsUnder: fairAmerican(1 - pOver),
  };
}
