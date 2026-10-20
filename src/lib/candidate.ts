import type { BetCategory, GradeSpec } from "../db/schema";
import type { GameInfo } from "./espn";
import { formatAmerican } from "./edge";

export type PriceSource = "book" | "model";

/**
 * One releasable wager. The engine generates many of these per slate; the
 * selection step keeps only those with a positive expected value at a price
 * the person can actually get.
 */
export interface Candidate {
  id: number;
  game: GameInfo;
  category: BetCategory;
  /** headline, e.g. "BOS -3.5" */
  pick: string;
  lineLabel: string;
  /**
   * The price the ledger and the staking math use.
   *  - book-priced: the sportsbook's posted price
   *  - model-priced: the WORST price at which the pick is still a play
   */
  odds: number;
  priceSource: PriceSource;
  /** estimated win probability (0..1), pushes excluded */
  modelProb: number;
  /** probability of a push (integer lines) */
  pPush: number;
  /** de-vigged market probability for the same side, when a posted price exists */
  marketProb: number | null;
  /** our fair price for the pick */
  fairOdds: number;
  /** model-priced picks: "play it at this price or better" */
  minOdds: number | null;
  /** expected profit per 1u staked at `odds` */
  ev: number;
  /** 0..1 haircut on how much we trust modelProb when sizing */
  trust: number;
  /** agents whose analysis supported the pick */
  signals: string[];
  /**
   * How many INDEPENDENT directional signals back the pick (rest, injuries,
   * ESPN's own projection...). One noisy signal is not a reason to bet.
   */
  agree: number;
  thesis: string;
  grade: GradeSpec;
  /** MMA: fine-grained market key (see markets.mmaMarketKey) */
  key?: string;
  /** set when a reviewer vetoed it */
  vetoed?: string;
  /** reviewer cautions that trimmed the probability */
  discount?: string;
  /** which sport bucket the pick belongs to for track-record gating */
  bucket: string;
  /** correlated bets share a cluster; a card keeps at most one per cluster per game */
  cluster: string;
  /** ranking score, higher is better (EV-driven for book picks) */
  rank: number;
  /** final staked units after sizing + caps */
  finalUnits?: number;
}

export const fmtOdds = formatAmerican;

export function fmtLine(v: number): string {
  return v > 0 ? `+${v}` : String(v);
}

export function pct(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits)}%`;
}

/** Bucket used for track-record gating: MMA promotions share one bucket. */
export function bucketOf(sport: string, category: string): string {
  const s = sport === "ufc" || sport === "dwcs" || sport === "pfl" ? "mma" : sport;
  return `${s}:${category}`;
}
