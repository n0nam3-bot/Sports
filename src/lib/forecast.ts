/**
 * Forecasts and how they are scored. Pure — no database, no network — so the maths is easy to test.
 *
 * A FORECAST is our win probability for the side we favour in a game, recorded next to the vig-free
 * market's. It is a prediction, not a bet. The SCOREBOARD grades every forecast once the game is final
 * and answers the question that matters: do our probabilities beat the market's own?
 *
 * Why Brier: it scores probabilities, not just winners. 0 is perfect; always saying 50% scores 0.25.
 * Hit rate alone can't tell skill from luck (or from just backing the favourite), so every score here is
 * also compared with the market's probability on the SAME games, with a standard error on the difference.
 */

export interface GameForecast {
  eventId: string;
  sport: string;
  matchup: string;
  /** ISO start time */
  startTime: string;
  side: "home" | "away";
  /** the side we favour — team or fighter name */
  pick: string;
  /** our P(pick wins); always >= 0.5 */
  pModel: number;
  /** the vig-free market's P(pick wins); below 0.5 when the market favours the other side; null with no posted moneyline */
  pMarket: number | null;
  /** one line of why */
  note: string;
}

/** A graded forecast, as the scoreboard reads it. `win` means the PICK won. */
export interface ScoredRow {
  sport: string;
  pModel: number;
  pMarket: number | null;
  outcome: "win" | "loss";
}

export type Verdict = "too early" | "no market to compare" | "beats the market" | "trails the market" | "no clear difference";

export interface Score {
  n: number;
  hits: number;
  hitRate: number | null;
  /** mean P(pick wins) we claimed */
  avgP: number | null;
  /** Brier score of our probabilities over every graded game (0 perfect; 0.25 = a coin flip each time) */
  brier: number | null;
  /** games where the market also gave a probability — the fair basis for comparing us with it */
  nPaired: number;
  brierModel: number | null;
  brierMarket: number | null;
  /** marketBrier − modelBrier over the paired games: positive = we beat the market */
  edge: number | null;
  /** standard error of that difference */
  edgeSe: number | null;
  /** hit rate of our picks vs of "always back the market's favourite", on the same paired games */
  modelHitRatePaired: number | null;
  marketHitRatePaired: number | null;
  /** games where the market favoured the OTHER side and we picked ours anyway */
  disagreed: number;
  disagreedRight: number;
  verdict: Verdict;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  /** mean probability we claimed in this bin */
  predicted: number;
  /** how often the pick actually won */
  actual: number;
}

export interface Scoreboard {
  overall: Score;
  bySport: { sport: string; score: Score }[];
  calibration: CalibrationBin[];
}

/** Paired games needed before we will say anything about us vs the market. */
export const MIN_PAIRED = 30;
/** ~95 % two-sided. */
export const Z95 = 1.96;

const BIN_EDGES = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 1.0000001];

const y = (r: ScoredRow): number => (r.outcome === "win" ? 1 : 0);
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Standard error of the mean of `xs` (sample sd / sqrt(n)); null below 2 observations. */
function stdErr(xs: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const m = xs.reduce((s, x) => s + x, 0) / n;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1);
  return Math.sqrt(v / n);
}

export function scoreRows(rows: ScoredRow[]): Score {
  const n = rows.length;
  const hits = rows.filter((r) => r.outcome === "win").length;
  const paired = rows.filter((r): r is ScoredRow & { pMarket: number } => r.pMarket != null);

  const brier = mean(rows.map((r) => (r.pModel - y(r)) ** 2));
  const brierModel = mean(paired.map((r) => (r.pModel - y(r)) ** 2));
  const brierMarket = mean(paired.map((r) => (r.pMarket - y(r)) ** 2));
  const diffs = paired.map((r) => (r.pMarket - y(r)) ** 2 - (r.pModel - y(r)) ** 2);
  const edge = mean(diffs);
  const edgeSe = stdErr(diffs);

  // "always back the market's favourite" on the same games: it wins when the favourite side wins.
  const marketHits = paired.filter((r) => (r.pMarket >= 0.5 ? r.outcome === "win" : r.outcome === "loss")).length;
  const modelHitsPaired = paired.filter((r) => r.outcome === "win").length;
  const disagreeRows = paired.filter((r) => r.pMarket < 0.5);

  let verdict: Verdict;
  if (n === 0 || paired.length === 0) verdict = n === 0 ? "too early" : "no market to compare";
  else if (paired.length < MIN_PAIRED || edge == null) verdict = "too early";
  else {
    const t = edgeSe && edgeSe > 0 ? edge / edgeSe : edge === 0 ? 0 : Math.sign(edge) * Infinity;
    verdict = t > Z95 ? "beats the market" : t < -Z95 ? "trails the market" : "no clear difference";
  }

  return {
    n,
    hits,
    hitRate: n ? hits / n : null,
    avgP: mean(rows.map((r) => r.pModel)),
    brier,
    nPaired: paired.length,
    brierModel,
    brierMarket,
    edge,
    edgeSe,
    modelHitRatePaired: paired.length ? modelHitsPaired / paired.length : null,
    marketHitRatePaired: paired.length ? marketHits / paired.length : null,
    disagreed: disagreeRows.length,
    disagreedRight: disagreeRows.filter((r) => r.outcome === "win").length,
    verdict,
  };
}

/** Do our stated probabilities mean what they say? In each probability band, how often did the pick win? */
export function calibration(rows: ScoredRow[]): CalibrationBin[] {
  const out: CalibrationBin[] = [];
  for (let i = 0; i < BIN_EDGES.length - 1; i++) {
    const lo = BIN_EDGES[i];
    const hi = BIN_EDGES[i + 1];
    const inBin = rows.filter((r) => r.pModel >= lo && r.pModel < hi);
    if (!inBin.length) continue;
    out.push({
      lo,
      hi: Math.min(hi, 1),
      n: inBin.length,
      predicted: inBin.reduce((s, r) => s + r.pModel, 0) / inBin.length,
      actual: inBin.filter((r) => r.outcome === "win").length / inBin.length,
    });
  }
  return out;
}

export function scoreForecasts(rows: ScoredRow[]): Scoreboard {
  const sports = [...new Set(rows.map((r) => r.sport))];
  const bySport = sports
    .map((sport) => ({ sport, score: scoreRows(rows.filter((r) => r.sport === sport)) }))
    .sort((a, b) => b.score.n - a.score.n || a.sport.localeCompare(b.sport));
  return { overall: scoreRows(rows), bySport, calibration: calibration(rows) };
}
