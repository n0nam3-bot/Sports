/**
 * Ledger vs Log.
 *
 * The **Ledger** holds every run that released something NEW (a play or a lean). The **Log** holds the
 * rest that finished: a pass, a re-run whose picks were all already on the ledger ("nothing new"), or a
 * failure. The server tags each run `productive` (it has pick rows of its own) and keeps the two groups
 * in separate windows (GET /api/runs), so a pile of idle runs can never push real ones out of the Ledger.
 *
 * Pure and dependency-free on purpose: the rules live here, the view just draws them, and
 * tests/ledger.test.ts pins them against real API payloads.
 */

/** The slice of a run these helpers read (RunC satisfies it). */
export interface RunLike {
  status: string;
  /** set by GET /api/runs; absent on the single-run endpoint, so it is derived when missing */
  productive?: boolean;
  predictions: { carried?: boolean }[];
}

export type RunKind =
  | "released" // released at least one NEW pick (a play or a lean)
  | "nothing-new" // released nothing new, but earlier picks on the ledger still stand
  | "pass" // released nothing, and nothing stands
  | "failed"
  | "running";

/** Did this run release at least one new pick? Trust the server's flag; derive it from the picks if absent. */
const released = (r: RunLike): boolean => r.productive ?? r.predictions.some((p) => !p.carried);

/** What a run did — for labelling it. */
export function runKind(r: RunLike): RunKind {
  if (r.status === "running") return "running";
  if (r.status === "failed") return "failed";
  if (released(r)) return "released";
  return r.predictions.some((p) => p.carried) ? "nothing-new" : "pass";
}

/**
 * Belongs in the Log: it is over and released nothing new. A run still in progress stays in the Ledger
 * (it may yet release something), and a failed run that did leave picks behind stays there too, so
 * those picks remain visible and gradable.
 */
export function isLogRun(r: RunLike): boolean {
  return r.status !== "running" && !released(r);
}

/** Split runs into Ledger and Log, keeping each group's order. Every run lands in exactly one. */
export function splitRuns<T extends RunLike>(runs: readonly T[]): { ledger: T[]; log: T[] } {
  const ledger: T[] = [];
  const log: T[] = [];
  for (const r of runs) (isLogRun(r) ? log : ledger).push(r);
  return { ledger, log };
}

/** The Ledger tab's badge: finished runs that released something. */
export function ledgerCount(runs: readonly RunLike[]): number {
  return runs.filter((r) => r.status === "completed" && !isLogRun(r)).length;
}
