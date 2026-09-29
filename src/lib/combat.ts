/**
 * Combat-sports pricing model (UFC / DWCS / PFL).
 *
 * ESPN's free feed publishes NO betting lines for MMA — verified against both
 * the site API and the core odds endpoint, which return zero items for every
 * bout. So every price here is the model's own fair number, derived from
 * fighter records, experience depth, division and scheduled distance.
 * These are explicitly labelled as model prices in the UI so they are never
 * mistaken for a sportsbook line.
 */

export interface FighterStrength {
  pct: number;
  fights: number;
}

/** Win rate shrunk toward .500 so a 4-0 prospect isn't priced like a champion. */
export function fighterStrength(record: string): FighterStrength {
  const m = record.match(/(\d+)\D+(\d+)(?:\D+(\d+))?/);
  if (!m) return { pct: 0.5, fights: 0 };
  const w = Number(m[1]);
  const l = Number(m[2]);
  const d = Number(m[3] ?? 0);
  const fights = w + l + d;
  if (!fights) return { pct: 0.5, fights: 0 };
  const raw = (w + 0.5 * d) / fights;
  const k = 6;
  return { pct: (raw * fights + 0.5 * k) / (fights + k), fights };
}

/** American price implied by a probability. */
export function fairAmerican(p: number): number {
  const clamped = Math.min(0.95, Math.max(0.05, p));
  return clamped >= 0.5
    ? -Math.round((clamped / (1 - clamped)) * 100)
    : Math.round(((1 - clamped) / clamped) * 100);
}

export interface CombatModel {
  /** probability the home-slot (second listed) fighter wins */
  pHome: number;
  pAway: number;
  fairHomeML: number;
  fairAwayML: number;
  /** probability the bout ends inside the distance */
  pFinish: number;
  fairFinish: number;
  fairDecision: number;
  /** expected completed rounds */
  expRounds: number;
  roundLine: number;
  pRoundsOver: number;
  fairRoundsOver: number;
  fairRoundsUnder: number;
}

export function combatModel(
  awayRecord: string,
  homeRecord: string,
  weightClass: string,
  scheduledRounds: number,
): CombatModel {
  const A = fighterStrength(awayRecord);
  const B = fighterStrength(homeRecord);
  const diff = B.pct - A.pct;
  // Experience depth breaks ties between similar win rates.
  const expEdge = Math.max(-0.06, Math.min(0.06, (B.fights - A.fights) * 0.004));
  const pHome = Math.min(0.88, Math.max(0.12, 0.5 + diff * 1.9 + expEdge));
  const pFav = Math.max(pHome, 1 - pHome);

  // Heavier divisions finish more; smaller divisions go to the cards more.
  const heavy = /heavy|light heavy|middle/i.test(weightClass);
  const light = /straw|fly|bantam|feather/i.test(weightClass);
  let pFinish = 0.46 + (pFav - 0.5) * 0.55 + (heavy ? 0.1 : 0) - (light ? 0.08 : 0);
  if (scheduledRounds === 5) pFinish -= 0.04;
  pFinish = Math.min(0.78, Math.max(0.24, pFinish));

  const expRounds = scheduledRounds * (1 - pFinish * 0.55);
  const roundLine = scheduledRounds === 5 ? 2.5 : 1.5;
  // Probability the fight lasts beyond the round line, tied to finish risk.
  const pRoundsOver = Math.min(
    0.9,
    Math.max(0.1, 1 - pFinish * (roundLine === 1.5 ? 0.62 : 0.78)),
  );

  return {
    pHome,
    pAway: 1 - pHome,
    fairHomeML: fairAmerican(pHome),
    fairAwayML: fairAmerican(1 - pHome),
    pFinish,
    fairFinish: fairAmerican(pFinish),
    fairDecision: fairAmerican(1 - pFinish),
    expRounds: Math.round(expRounds * 100) / 100,
    roundLine,
    pRoundsOver,
    fairRoundsOver: fairAmerican(pRoundsOver),
    fairRoundsUnder: fairAmerican(1 - pRoundsOver),
  };
}
