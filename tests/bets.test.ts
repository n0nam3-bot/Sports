import { test, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

(globalThis as unknown as Record<string, unknown>).__arenaNextJsPostgresqlDb = drizzle(new PGlite());

import { db } from "../src/db";
import { predictions, runs } from "../src/db/schema";
import { ensureSchema } from "../src/lib/schema";
import {
  betsToCsv,
  settleBet,
  summarise,
  upsertBet,
  validateBet,
  type TrackedBet,
} from "../src/lib/bets";

// ---------------------------------------------------------------------------
// pure logic
// ---------------------------------------------------------------------------
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("settleBet: the effective result follows the graded outcome unless overridden", () => {
  assert.deepEqual(settleBet("win", null, 1, -110), { result: "win", pnl: 0.909 });
  assert.deepEqual(settleBet("loss", null, 2, 150), { result: "loss", pnl: -2 });
  assert.deepEqual(settleBet("push", null, 1, -110), { result: "push", pnl: 0 });
  assert.deepEqual(settleBet("void", null, 1, -110), { result: "void", pnl: 0 });
  assert.deepEqual(settleBet("pending", null, 1, -110), { result: "pending", pnl: 0 });
  // a manual override wins over the ledger
  assert.deepEqual(settleBet("loss", "void", 1, -110), { result: "void", pnl: 0 });
  assert.deepEqual(settleBet("pending", "win", 2, 100), { result: "win", pnl: 2 });
  // garbage override is ignored
  assert.deepEqual(settleBet("win", "banana", 1, 100), { result: "win", pnl: 1 });
  // underdog and favourite payouts
  near(settleBet("win", null, 1, 250).pnl, 2.5);
  near(settleBet("win", null, 1, -200).pnl, 0.5);
});

test("validateBet accepts real tickets and rejects everything else", () => {
  const ok = validateBet({ predictionId: 7, stake: 1.239, odds: -115, note: "  DK  " });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.bet, { predictionId: 7, stake: 1.24, odds: -115, note: "DK" });
  for (const bad of [
    null, {}, { predictionId: "x", stake: 1, odds: -110 }, { predictionId: 1.5, stake: 1, odds: -110 },
    { predictionId: 1, stake: 0, odds: -110 }, { predictionId: 1, stake: -2, odds: -110 }, { predictionId: 1, stake: NaN, odds: -110 },
    { predictionId: 1, stake: 51, odds: -110 }, { predictionId: 1, stake: 1, odds: 99 }, { predictionId: 1, stake: 1, odds: -99 },
    { predictionId: 1, stake: 1, odds: 0 }, { predictionId: 1, stake: 1, odds: 110.5 }, { predictionId: 1, stake: 1, odds: "abc" },
  ]) {
    assert.equal(validateBet(bad).ok, false, JSON.stringify(bad));
  }
  // a very long note is truncated, not rejected
  const long = validateBet({ predictionId: 1, stake: 1, odds: -110, note: "x".repeat(500) });
  assert.ok(long.ok && long.bet.note!.length === 200);
});

function bet(over: Partial<TrackedBet> & { sport?: string; category?: string; result: TrackedBet["result"]; stake: number; odds: number }): TrackedBet {
  const { pnl } = settleBet(over.result, null, over.stake, over.odds);
  return {
    id: 1, predictionId: 1, note: "", placedAt: "", late: false, override: null, evAtPrice: null, pnl,
    prediction: { id: 1, matchup: "A @ B", sport: over.sport ?? "nba", category: over.category ?? "spread", pick: "p", lineLabel: "l", slateDate: "2026-10-10", startTime: null, odds: -110, units: 1, outcome: over.result, finalScore: null, modelProb: null, priceSource: "book", minPrice: null, engineVersion: 5 },
    ...over,
  } as TrackedBet;
}

test("summary: record, P/L, ROI, win rate and exposure", () => {
  const s = summarise(
    [
      bet({ result: "win", stake: 1, odds: -110 }), // +0.909
      bet({ result: "win", stake: 2, odds: 150 }), //  +3
      bet({ result: "loss", stake: 1.5, odds: -110 }), // -1.5
      bet({ result: "push", stake: 1, odds: -110 }),
      bet({ result: "void", stake: 4, odds: -110 }),
      bet({ result: "pending", stake: 2, odds: -110 }),
    ],
    null,
  );
  assert.equal(s.total, 6);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.pushes, 1);
  assert.equal(s.voids, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.atRisk, 2, "only pending bets are at risk");
  assert.equal(s.staked, 5.5, "void bets are not counted as risked; pushes are");
  near(s.pnl, 2.41, 0.011);
  near(s.roi!, 2.41 / 5.5, 0.01);
  near(s.winRate!, 2 / 3, 1e-3);
  assert.equal(s.followAllPnl, null);
  assert.equal(s.vsFollowAll, null);
});

test("summary: nothing settled → no ROI / win rate (never NaN or a misleading 0%)", () => {
  const empty = summarise([], null);
  assert.equal(empty.roi, null);
  assert.equal(empty.winRate, null);
  assert.equal(empty.pnl, 0);
  const onlyPending = summarise([bet({ result: "pending", stake: 1, odds: -110 })], null);
  assert.equal(onlyPending.roi, null);
  assert.equal(onlyPending.winRate, null);
  assert.equal(onlyPending.atRisk, 1);
  const onlyVoid = summarise([bet({ result: "void", stake: 1, odds: -110 })], null);
  assert.equal(onlyVoid.roi, null, "no staked units → no ROI");
  const onlyPush = summarise([bet({ result: "push", stake: 1, odds: -110 })], null);
  assert.equal(onlyPush.winRate, null, "pushes alone do not make a win rate");
});

test("summary: breakdowns by sport and market, and the follow-everything comparison", () => {
  const s = summarise(
    [
      bet({ result: "win", stake: 1, odds: 100, sport: "nba", category: "spread" }),
      bet({ result: "loss", stake: 1, odds: 100, sport: "nba", category: "total" }),
      bet({ result: "win", stake: 2, odds: 100, sport: "ufc", category: "fight_ml" }),
      bet({ result: "pending", stake: 1, odds: 100, sport: "ufc", category: "fight_ml" }),
    ],
    { pnl: 5.5, bets: 9 },
  );
  const nba = s.bySport.find((x) => x.key === "nba")!;
  assert.deepEqual([nba.bets, nba.wins, nba.losses, nba.pnl], [2, 1, 1, 0]);
  const ufc = s.bySport.find((x) => x.key === "ufc")!;
  assert.deepEqual([ufc.bets, ufc.pnl], [1, 2], "pending bets are excluded from the breakdown");
  assert.equal(s.byCategory.length, 3);
  assert.equal(s.followAllPnl, 5.5);
  assert.equal(s.followAllBets, 9);
  assert.equal(s.pnl, 2, "+1 − 1 + 2");
  assert.equal(s.vsFollowAll, -3.5, "you made 2.0u vs 5.5u for following everything");
});

// ---------------------------------------------------------------------------
// hardening
// ---------------------------------------------------------------------------
test("CSV export defuses spreadsheet formulas but leaves real numbers alone", () => {
  const evil = bet({ result: "win", stake: 1, odds: -110, note: '=HYPERLINK("http://evil.example","click")' });
  const plus = bet({ result: "win", stake: 1, odds: -110, note: "+1+1" });
  const at = bet({ result: "win", stake: 1, odds: -110, note: "@SUM(A1:A9)" });
  const dash = bet({ result: "win", stake: 1, odds: -110, note: "-2+3" });
  const normal = bet({ result: "loss", stake: 1.5, odds: 120, note: "plain, with a comma" });
  const csv = betsToCsv([evil, plus, at, dash, normal]);
  const lines = csv.split("\n");
  assert.match(lines[1], /"'=HYPERLINK/, "formula neutralised (and still correctly quoted)");
  assert.match(lines[2], /,'\+1\+1$/);
  assert.match(lines[3], /,'@SUM/);
  assert.match(lines[4], /,'-2\+3$/);
  assert.match(lines[5], /"plain, with a comma"$/);
  // the numeric odds column keeps its minus sign, un-prefixed
  assert.match(lines[1], /,1,-110,win,/);
  for (const l of lines.slice(1)) assert.ok(!/,[=+@]/.test(l.replace(/"[^"]*"/g, "")), l);
});

let predId = 0;
before(async () => {
  await ensureSchema();
  const [r] = await db.insert(runs).values({ ownerId: "house", slateDate: "2026-10-10", sports: ["nba"], status: "completed" }).returning();
  const [p] = await db
    .insert(predictions)
    .values({ ownerId: "house", dedupeKey: "k1", runId: r.id, sortOrder: 0, slateDate: "2026-10-10", sport: "nba", eventId: "E", matchup: "A @ B", category: "spread", pick: "B -1.5", lineLabel: "x", odds: -110, units: 1, confidence: 56, edge: 3, grade: { side: "home", line: -1.5 } })
    .returning();
  predId = p.id;
  for (const k of ["k2", "k3"]) {
    await db.insert(predictions).values({ ownerId: "house", dedupeKey: k, runId: r.id, sortOrder: 1, slateDate: "2026-10-10", sport: "nba", eventId: k, matchup: "A @ B", category: "spread", pick: "B -1.5", lineLabel: "x", odds: -110, units: 1, confidence: 56, edge: 3, grade: { side: "home", line: -1.5 } });
  }
});

test("a workspace can't store unbounded bets, but editing an existing one is always allowed", async () => {
  const all = await db.select({ id: predictions.id }).from(predictions);
  assert.ok(all.length >= 3);
  const [a, b, c] = all.map((x) => x.id);
  const owner = "wcaptestowner01";
  assert.ok((await upsertBet(owner, { predictionId: a, stake: 1, odds: -110 }, { maxBets: 2 })).ok);
  assert.ok((await upsertBet(owner, { predictionId: b, stake: 1, odds: -110 }, { maxBets: 2 })).ok);
  const third = await upsertBet(owner, { predictionId: c, stake: 1, odds: -110 }, { maxBets: 2 });
  assert.equal(third.ok, false);
  if (!third.ok) {
    assert.equal(third.status, 400);
    assert.match(third.error, /2-bet limit/);
  }
  // editing one of the two existing bets still works at the cap
  const edit = await upsertBet(owner, { predictionId: a, stake: 2, odds: -105 }, { maxBets: 2 });
  assert.ok(edit.ok);
  if (edit.ok) assert.equal(edit.bet.stake, 2);
  // another workspace is unaffected
  assert.ok((await upsertBet("wcaptestowner02", { predictionId: c, stake: 1, odds: -110 }, { maxBets: 2 })).ok);
  void predId;
});
