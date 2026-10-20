/**
 * Personal bet tracker.
 *
 * Nobody places every pick, and nobody gets exactly the suggested price. The
 * ledger's P/L assumes you bet everything at the suggested stake; this tracks
 * what a person ACTUALLY did — their stake and their price — and settles it
 * from the graded result of the prediction, so "my unit gain" is real.
 */

import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { predictions, userBets } from "@/db/schema";
import { ensureSchema } from "./schema";
import { evPerUnit, isAmerican, round, settledProfit } from "./edge";

export type Result = "pending" | "win" | "loss" | "push" | "void";
export const SETTLED_RESULTS: Result[] = ["win", "loss", "push", "void"];

export const MAX_STAKE_UNITS = 50;
/** The tracker is unauthenticated, so bound what any one workspace can store (and list). */
export const MAX_BETS_PER_OWNER = 5000;

export interface BetInput {
  predictionId: number;
  stake: number;
  odds: number;
  note?: string;
}

export interface TrackedPrediction {
  id: number;
  matchup: string;
  sport: string;
  category: string;
  pick: string;
  lineLabel: string;
  slateDate: string;
  startTime: string | null;
  /** the council's suggested price / stake */
  odds: number;
  units: number;
  outcome: string;
  finalScore: string | null;
  modelProb: number | null;
  priceSource: string;
  minPrice: number | null;
  engineVersion: number;
}

export interface TrackedBet {
  id: number;
  predictionId: number;
  stake: number;
  odds: number;
  note: string;
  placedAt: string;
  /** logged after the game had already started: a hindsight flag, not a block */
  late: boolean;
  /** a manual result the person set (book voided it, different line, ...) */
  override: Exclude<Result, "pending"> | null;
  /** effective result: the override if set, else the graded outcome */
  result: Result;
  /** profit in units at the person's own stake and price */
  pnl: number;
  /** expected value per unit at the person's price vs our probability (v5 picks) */
  evAtPrice: number | null;
  prediction: TrackedPrediction;
}

export interface Breakdown {
  key: string;
  bets: number;
  wins: number;
  losses: number;
  staked: number;
  pnl: number;
}

export interface BetSummary {
  /** every bet logged */
  total: number;
  pending: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  /** units risked on settled (non-void) bets */
  staked: number;
  /** units currently at risk on pending bets */
  atRisk: number;
  pnl: number;
  /** pnl / staked, as a fraction */
  roi: number | null;
  winRate: number | null;
  /** what following EVERY pick at the suggested stake/price would have made on the days you bet */
  followAllPnl: number | null;
  followAllBets: number;
  /** pnl - followAllPnl: positive means your selection beat blindly following the card */
  vsFollowAll: number | null;
  bySport: Breakdown[];
  byCategory: Breakdown[];
}

export function validateBet(input: unknown): { ok: true; bet: BetInput } | { ok: false; error: string } {
  const x = (input ?? {}) as Record<string, unknown>;
  const predictionId = Number(x.predictionId);
  if (!Number.isInteger(predictionId) || predictionId <= 0) return { ok: false, error: "predictionId required" };
  const stake = Number(x.stake);
  if (!Number.isFinite(stake) || stake <= 0) return { ok: false, error: "stake must be a positive number of units" };
  if (stake > MAX_STAKE_UNITS) return { ok: false, error: `stake can't exceed ${MAX_STAKE_UNITS} units` };
  const odds = Number(x.odds);
  if (!isAmerican(odds)) return { ok: false, error: "odds must be an American price like -110 or +150" };
  const note = typeof x.note === "string" ? x.note.trim().slice(0, 200) : "";
  return { ok: true, bet: { predictionId, stake: round(stake, 2), odds, note } };
}

const isResult = (v: unknown): v is Exclude<Result, "pending"> =>
  v === "win" || v === "loss" || v === "push" || v === "void";

/** Pure: the effective result and profit of one tracked bet. */
export function settleBet(
  graded: string,
  override: string | null,
  stake: number,
  odds: number,
): { result: Result; pnl: number } {
  const result: Result = isResult(override)
    ? override
    : graded === "win" || graded === "loss" || graded === "push" || graded === "void"
      ? graded
      : "pending";
  return { result, pnl: round(settledProfit(result, stake, odds), 3) };
}

function addTo(map: Map<string, Breakdown>, key: string, b: TrackedBet): void {
  const row = map.get(key) ?? { key, bets: 0, wins: 0, losses: 0, staked: 0, pnl: 0 };
  if (b.result !== "pending") {
    row.bets++;
    if (b.result === "win") row.wins++;
    if (b.result === "loss") row.losses++;
    if (b.result !== "void") row.staked += b.stake;
    row.pnl += b.pnl;
  }
  map.set(key, row);
}

/** Pure: roll a list of tracked bets up into the headline numbers. */
export function summarise(bets: TrackedBet[], followAll: { pnl: number; bets: number } | null): BetSummary {
  const s: BetSummary = {
    total: bets.length, pending: 0, wins: 0, losses: 0, pushes: 0, voids: 0,
    staked: 0, atRisk: 0, pnl: 0, roi: null, winRate: null,
    followAllPnl: null, followAllBets: 0, vsFollowAll: null, bySport: [], byCategory: [],
  };
  const sport = new Map<string, Breakdown>();
  const cat = new Map<string, Breakdown>();
  for (const b of bets) {
    switch (b.result) {
      case "pending":
        s.pending++;
        s.atRisk += b.stake;
        break;
      case "win":
        s.wins++;
        break;
      case "loss":
        s.losses++;
        break;
      case "push":
        s.pushes++;
        break;
      case "void":
        s.voids++;
        break;
    }
    if (b.result !== "pending") {
      if (b.result !== "void") s.staked += b.stake;
      s.pnl += b.pnl;
    }
    addTo(sport, b.prediction.sport, b);
    addTo(cat, b.prediction.category, b);
  }
  s.staked = round(s.staked, 2);
  s.atRisk = round(s.atRisk, 2);
  s.pnl = round(s.pnl, 2);
  s.roi = s.staked > 0 ? round(s.pnl / s.staked, 4) : null;
  const decided = s.wins + s.losses;
  s.winRate = decided > 0 ? round(s.wins / decided, 4) : null;
  if (followAll) {
    s.followAllPnl = round(followAll.pnl, 2);
    s.followAllBets = followAll.bets;
    s.vsFollowAll = round(s.pnl - followAll.pnl, 2);
  }
  const finish = (m: Map<string, Breakdown>): Breakdown[] =>
    [...m.values()]
      .filter((r) => r.bets > 0)
      .map((r) => ({ ...r, staked: round(r.staked, 2), pnl: round(r.pnl, 2) }))
      .sort((a, b) => b.bets - a.bets);
  s.bySport = finish(sport);
  s.byCategory = finish(cat);
  return s;
}

function toTrackedBet(
  row: {
    bet: typeof userBets.$inferSelect;
    p: typeof predictions.$inferSelect;
  },
): TrackedBet {
  const { bet, p } = row;
  const { result, pnl } = settleBet(p.outcome, bet.resultOverride, bet.stake, bet.odds);
  const started = p.startTime ? p.startTime.getTime() : null;
  return {
    id: bet.id,
    predictionId: bet.predictionId,
    stake: bet.stake,
    odds: bet.odds,
    note: bet.note,
    placedAt: bet.placedAt.toISOString(),
    late: started != null && bet.placedAt.getTime() > started,
    override: isResult(bet.resultOverride) ? bet.resultOverride : null,
    result,
    pnl,
    evAtPrice: p.modelProb != null ? round(evPerUnit(p.modelProb, bet.odds, 0), 4) : null,
    prediction: {
      id: p.id,
      matchup: p.matchup,
      sport: p.sport,
      category: p.category,
      pick: p.pick,
      lineLabel: p.lineLabel,
      slateDate: p.slateDate,
      startTime: p.startTime ? p.startTime.toISOString() : null,
      odds: p.odds,
      units: p.units,
      outcome: p.outcome,
      finalScore: p.finalScore,
      modelProb: p.modelProb,
      priceSource: p.priceSource,
      minPrice: p.minPrice,
      engineVersion: p.engineVersion,
    },
  };
}

async function loadBets(ownerId: string): Promise<TrackedBet[]> {
  const rows = await db
    .select({ bet: userBets, p: predictions })
    .from(userBets)
    .innerJoin(predictions, eq(userBets.predictionId, predictions.id))
    .where(eq(userBets.ownerId, ownerId))
    .orderBy(desc(userBets.placedAt))
    .limit(MAX_BETS_PER_OWNER);
  return rows.map(toTrackedBet);
}

/** What blindly following every released pick on the days you bet would have made. */
async function followAllBaseline(bets: TrackedBet[]): Promise<{ pnl: number; bets: number } | null> {
  const dates = [...new Set(bets.map((b) => b.prediction.slateDate))];
  if (!dates.length) return null;
  const rows = await db
    .select({ outcome: predictions.outcome, odds: predictions.odds, units: predictions.units })
    .from(predictions)
    .where(inArray(predictions.slateDate, dates));
  let pnl = 0;
  let n = 0;
  for (const r of rows) {
    if (r.outcome !== "win" && r.outcome !== "loss" && r.outcome !== "push") continue;
    n++;
    pnl += settledProfit(r.outcome, r.units, r.odds);
  }
  return { pnl, bets: n };
}

export async function listBets(ownerId: string): Promise<{ bets: TrackedBet[]; summary: BetSummary }> {
  await ensureSchema();
  const bets = await loadBets(ownerId);
  const baseline = bets.length ? await followAllBaseline(bets) : null;
  return { bets, summary: summarise(bets, baseline) };
}

export type UpsertResult = { ok: true; bet: TrackedBet } | { ok: false; error: string; status: number };

/** Log or edit a bet on a prediction (one per person per prediction). */
export async function upsertBet(
  ownerId: string,
  input: unknown,
  opts: { maxBets?: number } = {},
): Promise<UpsertResult> {
  const v = validateBet(input);
  if (!v.ok) return { ok: false, error: v.error, status: 400 };
  await ensureSchema();
  const [pred] = await db.select({ id: predictions.id }).from(predictions).where(eq(predictions.id, v.bet.predictionId));
  if (!pred) return { ok: false, error: "that prediction no longer exists", status: 404 };

  // Editing an existing bet is always allowed; only NEW bets count against the cap.
  const [existing] = await db
    .select({ id: userBets.id })
    .from(userBets)
    .where(and(eq(userBets.ownerId, ownerId), eq(userBets.predictionId, v.bet.predictionId)));
  if (!existing) {
    const [{ n }] = await db.select({ n: count() }).from(userBets).where(eq(userBets.ownerId, ownerId));
    const limit = opts.maxBets ?? MAX_BETS_PER_OWNER;
    if (n >= limit) {
      return { ok: false, error: `You've reached the ${limit}-bet limit — export a CSV and remove old bets.`, status: 400 };
    }
  }

  const now = new Date();
  await db
    .insert(userBets)
    .values({
      ownerId,
      predictionId: v.bet.predictionId,
      stake: v.bet.stake,
      odds: v.bet.odds,
      note: v.bet.note ?? "",
      placedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userBets.ownerId, userBets.predictionId],
      // editing keeps the original placed-at time (the hindsight flag stays honest)
      set: { stake: v.bet.stake, odds: v.bet.odds, note: v.bet.note ?? "", updatedAt: now },
    });

  const rows = await db
    .select({ bet: userBets, p: predictions })
    .from(userBets)
    .innerJoin(predictions, eq(userBets.predictionId, predictions.id))
    .where(and(eq(userBets.ownerId, ownerId), eq(userBets.predictionId, v.bet.predictionId)));
  return { ok: true, bet: toTrackedBet(rows[0]) };
}

export async function deleteBet(ownerId: string, predictionId: number): Promise<boolean> {
  await ensureSchema();
  const res = await db
    .delete(userBets)
    .where(and(eq(userBets.ownerId, ownerId), eq(userBets.predictionId, predictionId)))
    .returning({ id: userBets.id });
  return res.length > 0;
}

/**
 * Manually settle (or clear the settlement of) a tracked bet — for when the book
 * voided it, or the person took a different line than the pick. Only affects the
 * person's own tracker, never the shared ledger.
 */
export async function setBetResult(
  ownerId: string,
  predictionId: number,
  result: unknown,
): Promise<UpsertResult> {
  if (result !== null && !isResult(result)) {
    return { ok: false, error: "result must be win, loss, push, void or null", status: 400 };
  }
  await ensureSchema();
  const updated = await db
    .update(userBets)
    .set({ resultOverride: result, updatedAt: new Date() })
    .where(and(eq(userBets.ownerId, ownerId), eq(userBets.predictionId, predictionId)))
    .returning({ id: userBets.id });
  if (!updated.length) return { ok: false, error: "bet not found", status: 404 };
  const rows = await db
    .select({ bet: userBets, p: predictions })
    .from(userBets)
    .innerJoin(predictions, eq(userBets.predictionId, predictions.id))
    .where(and(eq(userBets.ownerId, ownerId), eq(userBets.predictionId, predictionId)));
  return { ok: true, bet: toTrackedBet(rows[0]) };
}

/** CSV for a person's own records / spreadsheet. */
export function betsToCsv(bets: TrackedBet[]): string {
  const esc = (v: string | number | null): string => {
    let s = v == null ? "" : String(v);
    // A text cell that starts with = + - @ (or a control char) is run as a formula by
    // Excel / Sheets. Defuse it. Real numbers (odds like -110) are left alone.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["date", "sport", "matchup", "pick", "market", "stake_u", "odds", "result", "pnl_u", "suggested_u", "suggested_odds", "note"];
  const lines = bets.map((b) =>
    [b.prediction.slateDate, b.prediction.sport, b.prediction.matchup, b.prediction.pick, b.prediction.category, b.stake, b.odds, b.result, b.pnl, b.prediction.units, b.prediction.odds, b.note]
      .map(esc)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n");
}
