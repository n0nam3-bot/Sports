/**
 * How selective the council is. This is the explicit volume-vs-quality dial:
 * forcing a full card of picks every day is the single most reliable way to
 * dilute a win rate, because marginal bets get released just to fill slots.
 */

export type Discipline = "strict" | "standard" | "loose";

export interface DisciplineConfig {
  id: Discipline;
  label: string;
  hint: string;
  /** minimum expected value per unit at the price on offer (book-priced picks) */
  minEv: number;
  /** most picks the card may contain */
  maxPicks: number;
  /** most total units the card may risk */
  dailyCap: number;
  /** independent signals that must agree */
  minAgree: number;
  /** added to every MMA probability floor (positive = pickier) */
  probShift: number;
  /** MMA picks must differ from the division base rate by at least this much */
  minDeviation: number;
}

export const DISCIPLINES: Record<Discipline, DisciplineConfig> = {
  strict: {
    id: "strict",
    label: "Strict",
    hint: "fewest picks, highest conviction",
    minEv: 0.035,
    maxPicks: 3,
    dailyCap: 5,
    minAgree: 2,
    probShift: 0.04,
    minDeviation: 0.06,
  },
  standard: {
    id: "standard",
    label: "Standard",
    hint: "positive EV with confirmation",
    minEv: 0.022,
    maxPicks: 6,
    dailyCap: 8,
    minAgree: 2,
    probShift: 0,
    minDeviation: 0.04,
  },
  loose: {
    id: "loose",
    label: "Loose",
    hint: "more action, lower bar",
    minEv: 0.012,
    maxPicks: 10,
    dailyCap: 12,
    minAgree: 1,
    probShift: -0.03,
    minDeviation: 0.03,
  },
};

export function disciplineOf(v: unknown): Discipline {
  return v === "strict" || v === "loose" ? v : "standard";
}
