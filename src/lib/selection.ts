/**
 * Card selection and unit management.
 *
 * What changed from the old "fill ten chairs" logic:
 *  - A candidate is released only if it clears an expected-value bar at the
 *    price on offer. Nothing is added to fill a quota; an empty card is a
 *    valid, often profitable, answer.
 *  - Stakes come from fractional Kelly (quarter-Kelly by default) on the
 *    estimated win probability and the real price, haircut for how much we
 *    trust the number — not from a made-up "confidence" ladder that grew with
 *    the size of our disagreement with the sportsbook.
 *  - Correlated bets are limited: one side-bet per game, one duration bet per
 *    fight, a per-game risk cap and a daily risk cap.
 */

import type { Candidate } from "./candidate";
import { DISCIPLINES, type Discipline, type DisciplineConfig } from "./discipline";
import { stakeUnits } from "./edge";
import { COMBAT_CATEGORIES } from "./markets";
import { PARAMS } from "./team-model";
import type { BucketHealth } from "./health";

const NEUTRAL: BucketHealth = {
  n: 0, wins: 0, expected: 0, z: 0, status: "new", stakeMult: 1, evBump: 0, note: "no history yet",
};

/** most units risked on a single game across all of its bets */
export const PER_GAME_CAP = 2;
/** single-bet ceilings */
export const MAX_UNITS_BOOK = 2;
export const MAX_UNITS_MODEL = 1;

export interface SelectInput {
  cands: Candidate[];
  discipline: Discipline;
  health?: Map<string, BucketHealth>;
  /** added to every EV requirement when the whole engine is running cold */
  globalBump?: number;
  /** picks allowed per game/bout (default 2) */
  perGameMax?: number;
}

export interface Rejected {
  c: Candidate;
  reason: string;
}

export interface SelectResult {
  card: Candidate[];
  rejected: Rejected[];
  /** total units risked */
  exposure: number;
}

const isCombat = (c: Candidate): boolean => COMBAT_CATEGORIES.has(c.category);
const isDerived = (c: Candidate): boolean => c.priceSource === "model" && !isCombat(c);

/** Same-bout picks that cannot both be right. */
export function contradicts(a: Candidate, b: Candidate): boolean {
  const x = a.grade.mma;
  const y = b.grade.mma;
  if (!x || !y) return false;
  const finishLike = (m: typeof x): boolean =>
    (m.kind === "method" && (m.method === "ko" || m.method === "sub")) ||
    (m.kind === "spread" && m.line === -1.5);
  const decisionLike = (m: typeof x): boolean => m.kind === "method" && m.method === "dec";
  const goes = (m: typeof x): boolean | null => (m.kind === "distance" ? m.yes : null);
  for (const [p, q] of [[x, y], [y, x]] as const) {
    if (finishLike(p) && goes(q) === true) return true;
    if (decisionLike(p) && goes(q) === false) return true;
  }
  return false;
}

function gate(c: Candidate, cfg: DisciplineConfig, h: BucketHealth, globalBump: number): string | null {
  if (c.vetoed) return `vetoed — ${c.vetoed}`;
  if (h.status === "frozen") return `${c.bucket} paused (${h.note})`;

  if (isCombat(c) && c.priceSource === "model") {
    // Probability floors and the base-rate deviation were applied when the pick
    // was generated; with no posted price there is no EV to test.
    if (c.agree < (cfg.id === "strict" ? 2 : 1)) return "strict mode needs fighter stats to confirm";
    return null;
  }

  const sportBump = PARAMS[c.game.sport]?.evBump ?? 0.01;
  const need = cfg.minEv + sportBump + h.evBump + globalBump + (isDerived(c) ? 0.01 : 0);
  if (c.ev < need) return `EV ${(c.ev * 100).toFixed(1)}% is under the ${(need * 100).toFixed(1)}% needed`;
  if (isDerived(c) && c.modelProb < 0.57) return "probability too low for a market with no posted line";
  if (!isDerived(c) && c.agree < cfg.minAgree) {
    return `only ${c.agree} of the ${cfg.minAgree} confirming signals needed`;
  }
  return null;
}

export function sizeOf(c: Candidate, h: BucketHealth = NEUTRAL): number {
  return stakeUnits({
    pWin: c.modelProb,
    american: c.odds,
    pPush: c.pPush,
    uncertainty: c.trust * h.stakeMult,
    maxUnits: c.priceSource === "model" ? MAX_UNITS_MODEL : MAX_UNITS_BOOK,
  });
}

export function selectCard(input: SelectInput): SelectResult {
  const cfg = DISCIPLINES[input.discipline];
  const health = input.health ?? new Map<string, BucketHealth>();
  const globalBump = input.globalBump ?? 0;
  const perGameMax = input.perGameMax ?? 2;
  const rejected: Rejected[] = [];
  const eligible: Candidate[] = [];

  for (const c of input.cands) {
    const h = health.get(c.bucket) ?? NEUTRAL;
    const why = gate(c, cfg, h, globalBump);
    if (why) {
      rejected.push({ c, reason: why });
      continue;
    }
    const units = sizeOf(c, h);
    if (units <= 0) {
      rejected.push({ c, reason: "edge too thin for even the minimum ticket" });
      continue;
    }
    c.finalUnits = units;
    eligible.push(c);
  }

  eligible.sort((a, b) => b.rank - a.rank);

  const card: Candidate[] = [];
  const perGame = new Map<string, { units: number; clusters: Set<string>; picks: Candidate[] }>();
  let exposure = 0;

  for (const c of eligible) {
    const units = c.finalUnits ?? 0;
    const gk = `${c.game.sport}:${c.game.eventId}`;
    const st = perGame.get(gk) ?? { units: 0, clusters: new Set<string>(), picks: [] };
    let why: string | null = null;
    if (card.length >= cfg.maxPicks) why = `card is full (${cfg.maxPicks} picks)`;
    else if (st.clusters.has(c.cluster)) why = "a better pick already covers this angle";
    else if (st.picks.length >= perGameMax) why = "per-game pick limit reached";
    else if (st.picks.some((p) => contradicts(p, c))) why = "contradicts a stronger pick on this fight";
    else if (st.units + units > PER_GAME_CAP + 1e-9) why = `would put more than ${PER_GAME_CAP}u on one game`;
    else if (exposure + units > cfg.dailyCap + 1e-9) why = `daily risk cap of ${cfg.dailyCap}u`;
    if (why) {
      rejected.push({ c, reason: why });
      continue;
    }
    card.push(c);
    st.units += units;
    st.clusters.add(c.cluster);
    st.picks.push(c);
    perGame.set(gk, st);
    exposure += units;
  }

  return { card, rejected, exposure: Math.round(exposure * 100) / 100 };
}

/**
 * The best candidates that did not make the card, for the council memo.
 * Substantive near-misses (the price/edge wasn't there, a reviewer objected)
 * come first. "A better pick already covers this angle" is redundancy, not a
 * near-miss, so it is only used to fill leftover space.
 */
const REDUNDANT = /already covers|per-game pick limit|contradicts a stronger/;

export function nearMisses(rejected: Rejected[], limit = 6): Rejected[] {
  const byRank = [...rejected].sort((a, b) => b.c.rank - a.c.rank);
  const substantive = byRank.filter((r) => !REDUNDANT.test(r.reason));
  const redundant = byRank.filter((r) => REDUNDANT.test(r.reason));
  return [...substantive.slice(0, limit), ...redundant.slice(0, Math.max(0, Math.min(2, limit - substantive.length)))];
}
