/**
 * Track-record gating — the engine's real "self-improvement".
 *
 * The old system "improved" by asking an LLM to rewrite an agent's prompt after
 * 8 graded bets. Eight bets is pure noise (a coin-flip agent will look cold
 * about half the time), the rewrites accumulated into contradictory prompt
 * sludge, and for the deterministic scouts the rewrite changed display text
 * but no behaviour at all.
 *
 * This replaces it with something that can actually protect a bankroll. For
 * each market bucket (e.g. "nba:spread", "mma:fight_rounds") we ask one
 * question using only the recent graded picks released by the current engine:
 *
 *    "Are these results meaningfully WORSE than the prices we took would
 *     break even at?"
 *
 * It is a plain z-test of wins against the sum of the break-even
 * probabilities. A bucket must be clearly cold over enough bets before
 * anything changes, and the response is a throttle (smaller stakes, higher bar)
 * or a temporary freeze — never a rewrite. Because only the last few weeks
 * count, a frozen bucket thaws on its own as old results age out.
 */

import { and, desc, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { predictions } from "@/db/schema";
import { ensureSchema } from "./schema";
import { impliedProb } from "./edge";
import { bucketOf } from "./candidate";

export interface HealthRow {
  sport: string;
  category: string;
  outcome: string;
  odds: number;
}

export interface BucketHealth {
  n: number;
  wins: number;
  /** wins expected if the bucket merely breaks even at the prices taken */
  expected: number;
  z: number;
  status: "new" | "ok" | "cold" | "frozen";
  /** multiply stakes by this */
  stakeMult: number;
  /** add this to the minimum EV required */
  evBump: number;
  note: string;
}

export const MIN_BETS_TO_JUDGE = 20;
export const MIN_BETS_TO_FREEZE = 30;
export const COLD_Z = -1.3;
export const FREEZE_Z = -2.0;

export function zScore(rows: { outcome: string; odds: number }[]): {
  n: number;
  wins: number;
  expected: number;
  z: number;
} {
  let n = 0;
  let wins = 0;
  let expected = 0;
  let variance = 0;
  for (const r of rows) {
    if (r.outcome !== "win" && r.outcome !== "loss") continue; // pushes/voids carry no information
    const p = impliedProb(r.odds);
    n++;
    expected += p;
    variance += p * (1 - p);
    if (r.outcome === "win") wins++;
  }
  const z = variance > 0 ? (wins - expected) / Math.sqrt(variance) : 0;
  return { n, wins, expected, z };
}

function judge(rows: HealthRow[]): BucketHealth {
  const { n, wins, expected, z } = zScore(rows);
  const base = { n, wins, expected: Math.round(expected * 10) / 10, z: Math.round(z * 100) / 100 };
  if (n < MIN_BETS_TO_JUDGE) {
    return { ...base, status: "new", stakeMult: 1, evBump: 0, note: `${n} graded — too few to judge` };
  }
  if (n >= MIN_BETS_TO_FREEZE && z <= FREEZE_Z) {
    return {
      ...base,
      status: "frozen",
      stakeMult: 0,
      evBump: 0.03,
      note: `${wins}-${n - wins} vs ${expected.toFixed(1)} expected (z ${z.toFixed(1)}) — paused until results improve`,
    };
  }
  if (z <= COLD_Z) {
    return {
      ...base,
      status: "cold",
      stakeMult: 0.5,
      evBump: 0.015,
      note: `${wins}-${n - wins} vs ${expected.toFixed(1)} expected (z ${z.toFixed(1)}) — half stakes, higher bar`,
    };
  }
  return { ...base, status: "ok", stakeMult: 1, evBump: 0, note: `${wins}-${n - wins} (z ${z.toFixed(1)})` };
}

export interface HealthReport {
  buckets: Map<string, BucketHealth>;
  /** applied to every pick when the whole engine is running cold */
  globalBump: number;
  overall: BucketHealth;
}

/** Pure: turn graded rows into per-bucket verdicts. */
export function computeHealth(rows: HealthRow[]): HealthReport {
  const groups = new Map<string, HealthRow[]>();
  for (const r of rows) {
    const key = bucketOf(r.sport, r.category);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const buckets = new Map<string, BucketHealth>();
  for (const [key, list] of groups) buckets.set(key, judge(list));
  const overall = judge(rows);
  const globalBump = overall.n >= 40 && overall.z <= -1.5 ? 0.01 : 0;
  return { buckets, globalBump, overall };
}

export const NEUTRAL: BucketHealth = {
  n: 0,
  wins: 0,
  expected: 0,
  z: 0,
  status: "new",
  stakeMult: 1,
  evBump: 0,
  note: "no history yet",
};

/**
 * Load the recent graded picks released by the current engine (v5+).
 * Older engines are excluded on purpose: the new engine earns its own record.
 */
export async function loadHealth(days = 28): Promise<HealthReport> {
  await ensureSchema();
  const cutoff = new Date(Date.now() - days * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const rows = await db
    .select({
      sport: predictions.sport,
      category: predictions.category,
      outcome: predictions.outcome,
      odds: predictions.odds,
    })
    .from(predictions)
    .where(
      and(
        gte(predictions.engineVersion, 5),
        gte(predictions.slateDate, cutoff),
        inArray(predictions.outcome, ["win", "loss"]),
      ),
    )
    .orderBy(desc(predictions.id))
    .limit(800);
  return computeHealth(rows);
}
