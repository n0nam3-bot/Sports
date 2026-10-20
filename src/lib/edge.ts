/**
 * Pricing + bankroll math. Everything here is pure (no I/O) so it can be unit
 * tested and shared by the engine, the MMA model and the bet tracker.
 *
 * Conventions
 *  - "american" is a signed integer price (-110, +150). |price| >= 100.
 *  - "units" are bankroll units: 1u = 1% of a 100u bankroll.
 *  - Probabilities are 0..1. A "win probability" never includes pushes.
 */

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** A usable American price: an integer with |price| >= 100 and sane magnitude. */
export function isAmerican(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    Math.abs(v) >= 100 &&
    Math.abs(v) <= 100_000
  );
}

/** Implied probability of a price. Includes the book's margin (vig). */
export function impliedProb(american: number): number {
  return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
}

/** Profit on a winning 1u stake (e.g. -110 → 0.909, +150 → 1.5). */
export function profitPerUnit(american: number): number {
  return american > 0 ? american / 100 : 100 / -american;
}

export function americanToDecimal(american: number): number {
  return 1 + profitPerUnit(american);
}

/** The price whose implied probability is p. Even money is shown as +100. */
export function fairAmerican(p: number): number {
  const c = clamp(p, 0.02, 0.98);
  if (c > 0.5) return -Math.round((c / (1 - c)) * 100);
  return Math.round(((1 - c) / c) * 100);
}

export function formatAmerican(a: number): string {
  return a > 0 ? `+${a}` : String(a);
}

/**
 * Remove the vig from a two-way market (proportional method). Returns the
 * "true" probabilities of side 1 and side 2, which sum to 1.
 */
export function devigTwoWay(a1: number, a2: number): [number, number] {
  const p1 = impliedProb(a1);
  const p2 = impliedProb(a2);
  const total = p1 + p2;
  if (!(total > 0)) return [0.5, 0.5];
  return [p1 / total, p2 / total];
}

// ---------------------------------------------------------------------------
// normal distribution
// ---------------------------------------------------------------------------

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |err| < 1.5e-7). */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/** Inverse standard normal CDF (Acklam, relative error ~1e-9). */
export function normInv(p: number): number {
  const q = clamp(p, 1e-9, 1 - 1e-9);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (q < lo) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) /
      ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  if (q > 1 - lo) {
    const r = Math.sqrt(-2 * Math.log(1 - q));
    return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) /
      ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  const r = q - 0.5;
  const s = r * r;
  return ((((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r) /
    (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}

/**
 * Move a probability by `deltaPoints` of expected margin/total, where `sigma`
 * is the standard deviation of the underlying outcome in the same units.
 * Positive delta makes the event more likely. Works from the market's own
 * probability so the market stays the prior and the model only nudges it.
 */
export function shiftProb(p: number, deltaPoints: number, sigma: number): number {
  if (!(sigma > 0)) return p;
  return clamp(normCdf(normInv(clamp(p, 0.01, 0.99)) + deltaPoints / sigma), 0.01, 0.99);
}

// ---------------------------------------------------------------------------
// expected value + staking
// ---------------------------------------------------------------------------

/** Expected profit per 1u staked. A push returns the stake (profit 0). */
export function evPerUnit(pWin: number, american: number, pPush = 0): number {
  const pLoss = 1 - pWin - pPush;
  return profitPerUnit(american) * pWin - pLoss;
}

/**
 * Full-Kelly fraction of bankroll for a bet that wins `b`, loses 1 and
 * pushes with probability `pPush`. Zero when there is no edge.
 */
export function kellyFraction(pWin: number, american: number, pPush = 0): number {
  const b = profitPerUnit(american);
  const ev = evPerUnit(pWin, american, pPush);
  if (!(ev > 0)) return 0;
  const f = ev / (b * (1 - pPush));
  return clamp(f, 0, 1);
}

export interface StakeInput {
  pWin: number;
  american: number;
  pPush?: number;
  /** bankroll expressed in units. 100 → 1u is 1% of the bankroll. */
  bankrollUnits?: number;
  /** fraction of full Kelly to stake. Quarter-Kelly is the default. */
  kellyMultiplier?: number;
  /** 0..1 haircut for how much we trust the probability (model-priced = lower). */
  uncertainty?: number;
  maxUnits?: number;
  minUnits?: number;
  step?: number;
}

/**
 * Stake in units. Rounds DOWN to `step` so sizing is never rounded into more
 * risk than the math allows, and returns 0 when the edge is too small to
 * justify the minimum ticket.
 */
export function stakeUnits(i: StakeInput): number {
  const step = i.step ?? 0.25;
  const f = kellyFraction(i.pWin, i.american, i.pPush ?? 0);
  if (f <= 0) return 0;
  const raw =
    (i.bankrollUnits ?? 100) * (i.kellyMultiplier ?? 0.25) * f * clamp(i.uncertainty ?? 1, 0, 1);
  const q = Math.floor(raw / step + 1e-9) * step;
  if (q + 1e-9 < (i.minUnits ?? 0.25)) return 0;
  return Math.min(i.maxUnits ?? 2, q);
}

/**
 * Worst American price at which a bet we rate at `pWin` still keeps a
 * `cushion` of probability in our favour. This is the "play it at X or
 * better" number shown on every model-priced pick.
 */
export function minAcceptableAmerican(pWin: number, cushion: number): number {
  return fairAmerican(clamp(pWin - cushion, 0.02, 0.97));
}

/** Settled profit in units for a ticket. */
export function settledProfit(
  outcome: string,
  stake: number,
  american: number,
): number {
  if (outcome === "win") return stake * profitPerUnit(american);
  if (outcome === "loss") return -stake;
  return 0; // push / void / pending
}

/** Round to a fixed number of decimals without float noise. */
export function round(v: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
