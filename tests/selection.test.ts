import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candidate } from "../src/lib/candidate";
import { bucketOf } from "../src/lib/candidate";
import { DISCIPLINES } from "../src/lib/discipline";
import { evPerUnit } from "../src/lib/edge";
import { computeHealth, zScore, type BucketHealth } from "../src/lib/health";
import { nearMisses, PER_GAME_CAP, selectCard, sizeOf } from "../src/lib/selection";
import { teamGame } from "./helpers";

let n = 0;
/** A book-priced NBA candidate that clears every bar unless overridden. */
function cand(over: Partial<Candidate> & { gameId?: string } = {}): Candidate {
  const g = teamGame({ eventId: over.gameId ?? `g${n}` });
  const odds = over.odds ?? -110;
  const p = over.modelProb ?? 0.57;
  const c: Candidate = {
    id: ++n,
    game: g,
    category: "spread",
    pick: `pick ${n}`,
    lineLabel: "x",
    odds,
    priceSource: "book",
    modelProb: p,
    pPush: 0,
    marketProb: 0.5,
    fairOdds: -130,
    minOdds: null,
    ev: evPerUnit(p, odds, 0),
    trust: 1,
    signals: ["QUANT", "MEDIC"],
    agree: 2,
    thesis: "",
    grade: { side: "home", line: -3.5 },
    bucket: bucketOf("nba", "spread"),
    cluster: "side",
    rank: 0,
    ...over,
  };
  c.ev = over.ev ?? evPerUnit(c.modelProb, c.odds, c.pPush);
  c.rank = over.rank ?? c.ev * 100 + 10 * (c.modelProb - 0.5);
  return c;
}

test("never pads the card: an empty slate returns an empty card", () => {
  const r = selectCard({ cands: [], discipline: "loose" });
  assert.equal(r.card.length, 0);
  assert.equal(r.exposure, 0);
});

test("below-bar candidates are rejected with a reason, not released to fill space", () => {
  const weak = [cand({ modelProb: 0.52 }), cand({ modelProb: 0.53 }), cand({ modelProb: 0.5 })];
  const r = selectCard({ cands: weak, discipline: "standard" });
  assert.equal(r.card.length, 0);
  assert.equal(r.rejected.length, 3);
  assert.ok(r.rejected.every((x) => x.reason.length > 0));
});

test("pick count, per-game limits and the daily risk cap are all enforced", () => {
  for (const d of ["strict", "standard", "loose"] as const) {
    const cfg = DISCIPLINES[d];
    const many = Array.from({ length: 30 }, (_, i) => cand({ modelProb: 0.6 + (i % 5) * 0.01, gameId: `many${i}` }));
    const r = selectCard({ cands: many, discipline: d });
    assert.ok(r.card.length <= cfg.maxPicks, `${d}: ${r.card.length} picks`);
    assert.ok(r.exposure <= cfg.dailyCap + 1e-9, `${d}: exposure ${r.exposure}`);
    const total = r.card.reduce((s, c) => s + (c.finalUnits ?? 0), 0);
    assert.ok(Math.abs(total - r.exposure) < 1e-9);
  }
});

test("only one pick per cluster per game (spread and moneyline on a side are one bet)", () => {
  const g = "same-game";
  const a = cand({ gameId: g, modelProb: 0.62, cluster: "side", category: "spread" });
  const b = cand({ gameId: g, modelProb: 0.61, cluster: "side", category: "moneyline", bucket: bucketOf("nba", "moneyline") });
  const c = cand({ gameId: g, modelProb: 0.6, cluster: "total", category: "total", bucket: bucketOf("nba", "total") });
  // all three share one GameInfo identity key (sport:eventId)
  const r = selectCard({ cands: [a, b, c], discipline: "loose" });
  const clusters = r.card.map((x) => x.cluster);
  assert.equal(new Set(clusters).size, clusters.length, clusters.join(","));
  assert.ok(r.card.some((x) => x.cluster === "side"));
});

test("per-game exposure never exceeds the cap", () => {
  const g = "cap-game";
  const cs = [
    cand({ gameId: g, modelProb: 0.7, cluster: "a" }),
    cand({ gameId: g, modelProb: 0.7, cluster: "b" }),
    cand({ gameId: g, modelProb: 0.7, cluster: "c" }),
  ];
  const r = selectCard({ cands: cs, discipline: "loose", perGameMax: 5 });
  const total = r.card.reduce((s, x) => s + (x.finalUnits ?? 0), 0);
  assert.ok(total <= PER_GAME_CAP + 1e-9, `risked ${total}u on one game`);
});

test("sizing: bigger edge → bigger stake, hard ceilings, model-priced picks risk less", () => {
  // quarter-Kelly on a 100u bankroll at -110: 53.5% → 0.5u, 54.5% → 1u, 55.5% → 1.5u
  const small = sizeOf(cand({ modelProb: 0.535 }));
  const mid = sizeOf(cand({ modelProb: 0.545 }));
  const big = sizeOf(cand({ modelProb: 0.555 }));
  assert.equal(small, 0.5);
  assert.equal(mid, 1);
  assert.equal(big, 1.5);
  // and a huge (unrealistic) edge is still capped at 2u
  assert.equal(sizeOf(cand({ modelProb: 0.7 })), 2);
  const model = sizeOf(cand({ modelProb: 0.7, priceSource: "model", trust: 0.5 }));
  assert.ok(model <= 1, `model-priced stake ${model}`);
  // a thin edge is not rounded UP into a bet
  assert.equal(sizeOf(cand({ modelProb: 0.528 })), 0);
  // stakes are multiples of a quarter unit
  for (const p of [0.54, 0.555, 0.59, 0.63]) {
    const u = sizeOf(cand({ modelProb: p }));
    assert.equal(Math.round(u * 4) / 4, u);
  }
});

test("a vetoed candidate is never released", () => {
  const v = cand({ modelProb: 0.7, vetoed: "starter scratched" });
  const r = selectCard({ cands: [v], discipline: "loose" });
  assert.equal(r.card.length, 0);
  assert.match(r.rejected[0].reason, /vetoed/);
});

test("track-record gating: frozen buckets are skipped, cold buckets get half stakes", () => {
  const key = bucketOf("nba", "spread");
  const mk = (over: Partial<BucketHealth>): Map<string, BucketHealth> =>
    new Map([[key, { n: 40, wins: 10, expected: 20, z: -3, status: "frozen", stakeMult: 0, evBump: 0.03, note: "test", ...over }]]);
  const c1 = cand({ modelProb: 0.56 });
  const frozen = selectCard({ cands: [c1], discipline: "loose", health: mk({}) });
  assert.equal(frozen.card.length, 0);
  assert.match(frozen.rejected[0].reason, /paused/);

  const coldHealth = mk({ status: "cold", stakeMult: 0.5, evBump: 0.015, z: -1.5 });
  // 56% at -110 is 1.75u when healthy; a cold bucket halves the stake (0.95 → 0.75u)
  const healthy = selectCard({ cands: [cand({ modelProb: 0.56 })], discipline: "loose" });
  const cold = selectCard({ cands: [cand({ modelProb: 0.56 })], discipline: "loose", health: coldHealth });
  assert.equal(healthy.card.length, 1);
  assert.equal(cold.card.length, 1);
  assert.equal(healthy.card[0].finalUnits, 1.75);
  assert.equal(cold.card[0].finalUnits, 0.75);

  // a cold bucket also needs more edge to be released at all:
  // 53.5% is +2.1% EV — fine for loose (needs 1.2%) but not once the bar is raised by 1.5 points
  const marginalHealthy = selectCard({ cands: [cand({ modelProb: 0.535 })], discipline: "loose" });
  const marginalCold = selectCard({ cands: [cand({ modelProb: 0.535 })], discipline: "loose", health: coldHealth });
  assert.equal(marginalHealthy.card.length, 1);
  assert.equal(marginalCold.card.length, 0);
});

test("derived (model-line) markets are held to a higher bar than posted-line markets", () => {
  const posted = cand({ modelProb: 0.55 }); // EV ≈ +5% at -110
  const derived = cand({ modelProb: 0.55, priceSource: "model", category: "team_total", trust: 0.5, bucket: bucketOf("nba", "team_total"), agree: 0 });
  assert.equal(selectCard({ cands: [posted], discipline: "standard" }).card.length, 1);
  assert.equal(selectCard({ cands: [derived], discipline: "standard" }).card.length, 0);
});

// ---------------------------------------------------------------------------
// track-record statistics
// ---------------------------------------------------------------------------
const rows = (wins: number, losses: number, odds = -110, sport = "nba", category = "spread") => [
  ...Array.from({ length: wins }, () => ({ sport, category, outcome: "win", odds })),
  ...Array.from({ length: losses }, () => ({ sport, category, outcome: "loss", odds })),
];

test("z-score is wins vs the break-even expectation of the prices taken", () => {
  // 55-45 at -110: expected 52.38 wins
  const z = zScore(rows(55, 45));
  assert.equal(z.n, 100);
  assert.ok(Math.abs(z.expected - 52.38) < 0.01);
  assert.ok(z.z > 0 && z.z < 1);
  // pushes and voids carry no information
  const withPush = zScore([...rows(55, 45), { outcome: "push", odds: -110 }, { outcome: "void", odds: -110 }]);
  assert.equal(withPush.n, 100);
});

test("a small sample is never judged — the old loop rewrote prompts after 8 bets", () => {
  const h = computeHealth(rows(2, 8)).buckets.get("nba:spread")!;
  assert.equal(h.status, "new");
  assert.equal(h.stakeMult, 1);
});

test("clearly cold buckets are throttled, then frozen with enough evidence", () => {
  const cold = computeHealth(rows(8, 17)).buckets.get("nba:spread")!; // 25 bets, z ≈ -2
  assert.equal(cold.status, "cold");
  assert.equal(cold.stakeMult, 0.5);
  const frozen = computeHealth(rows(12, 28)).buckets.get("nba:spread")!; // 40 bets
  assert.equal(frozen.status, "frozen");
  assert.equal(frozen.stakeMult, 0);
});

test("an ordinary cold streak does NOT trip the breaker", () => {
  // 20-25 at -110: unlucky but within noise
  const h = computeHealth(rows(21, 24)).buckets.get("nba:spread")!;
  assert.equal(h.status, "ok");
});

test("MMA promotions share a bucket; sports don't bleed into each other", () => {
  const mixed = [...rows(20, 5, -150, "ufc", "fight_ml"), ...rows(4, 10, -150, "pfl", "fight_ml"), ...rows(30, 30, -110, "nba", "spread")];
  const { buckets } = computeHealth(mixed);
  assert.ok(buckets.has("mma:fight_ml"));
  assert.equal(buckets.get("mma:fight_ml")!.n, 39);
  assert.equal(buckets.get("nba:spread")!.n, 60);
  assert.ok(!buckets.has("ufc:fight_ml"));
});

test("the whole engine running cold raises everyone's bar", () => {
  const bad = rows(18, 32); // 50 bets
  const rep = computeHealth(bad);
  assert.equal(rep.globalBump, 0.01);
  assert.equal(computeHealth(rows(28, 22)).globalBump, 0);
});

// ---------------------------------------------------------------------------
// leans
// ---------------------------------------------------------------------------
test("leans: a real but sub-bar edge is published with NO stake; no edge → nothing", () => {
  // standard needs 2.2% EV. 53.5% at -110 is +2.1% (a lean); 52% is negative (nothing).
  const lean = cand({ modelProb: 0.535, gameId: "L1" });
  const none = cand({ modelProb: 0.52, gameId: "L2" });
  const tiny = cand({ modelProb: 0.5245, gameId: "L3" }); // +0.1% EV: below even the lean floor
  const r = selectCard({ cands: [lean, none, tiny], discipline: "standard" });
  assert.equal(r.card.length, 0);
  assert.deepEqual(r.leans.map((c) => c.id), [lean.id]);
  assert.equal(r.leans[0].finalUnits, 0, "a lean carries no suggested stake");
  assert.ok(r.exposure === 0, "leans add no risk to the card");
});

test("leans: never an angle a play already covers, and one lean per angle", () => {
  const play = cand({ modelProb: 0.58, gameId: "G", cluster: "side" });
  const sameAngle = cand({ modelProb: 0.535, gameId: "G", cluster: "side", category: "moneyline", bucket: bucketOf("nba", "moneyline") });
  const otherAngle = cand({ modelProb: 0.535, gameId: "G", cluster: "total", category: "total", bucket: bucketOf("nba", "total") });
  const twinA = cand({ modelProb: 0.534, gameId: "H", cluster: "side" });
  const twinB = cand({ modelProb: 0.532, gameId: "H", cluster: "side", category: "moneyline", bucket: bucketOf("nba", "moneyline") });
  const r = selectCard({ cands: [play, sameAngle, otherAngle, twinA, twinB], discipline: "standard" });
  assert.deepEqual(r.card.map((c) => c.id), [play.id]);
  const ids = r.leans.map((c) => c.id);
  assert.ok(!ids.includes(sameAngle.id), "the play already covers this angle");
  assert.ok(ids.includes(otherAngle.id), "a different angle on the same game can be a lean");
  assert.equal(ids.filter((i) => i === twinA.id || i === twinB.id).length, 1, "one lean per angle");
  assert.ok(ids.includes(twinA.id), "the stronger twin is the one kept");
});

test("leans: capped per discipline and ranked best-first", () => {
  const many = Array.from({ length: 12 }, (_, i) => cand({ modelProb: 0.53 + (i % 4) * 0.001, gameId: `LN${i}` }));
  for (const [d, cap] of [["strict", 3], ["standard", 5], ["loose", 6]] as const) {
    const r = selectCard({ cands: many.map((c) => ({ ...c })), discipline: d });
    assert.ok(r.leans.length <= cap, `${d}: ${r.leans.length} leans`);
  }
  const r = selectCard({ cands: many, discipline: "standard" });
  const ranks = r.leans.map((c) => c.rank);
  assert.deepEqual([...ranks].sort((a, b) => b - a), ranks);
});

test("leans: only posted-price picks that are not vetoed or paused", () => {
  const model = cand({ modelProb: 0.535, priceSource: "model", category: "team_total", bucket: bucketOf("nba", "team_total"), gameId: "M1" });
  const vetoed = cand({ modelProb: 0.535, vetoed: "star ruled out", gameId: "M2" });
  const pausedKey = bucketOf("nba", "total");
  const paused = cand({ modelProb: 0.535, bucket: pausedKey, category: "total", cluster: "total", gameId: "M3" });
  const health = new Map([[pausedKey, { n: 40, wins: 10, expected: 20, z: -3, status: "frozen" as const, stakeMult: 0, evBump: 0.03, note: "cold" }]]);
  const r = selectCard({ cands: [model, vetoed, paused], discipline: "loose", health });
  assert.deepEqual(r.leans, [], "model-priced, vetoed and frozen candidates are not leans");
});

test("leans: a pick that cleared the bar but did not fit on the card becomes a lean", () => {
  // strict allows 3 picks. Four ~1u picks all clear the 3.5% bar; the 4th has real edge but no room.
  const picks = [0.546, 0.545, 0.544, 0.543].map((p, i) => cand({ modelProb: p, gameId: `FULL${i}` }));
  const r = selectCard({ cands: picks, discipline: "strict" });
  assert.equal(r.card.length, 3);
  assert.equal(r.leans.length, 1);
  assert.equal(r.leans[0].finalUnits, 0);
  assert.ok(r.leans[0].ev > 0.035, "it genuinely had the edge — it just did not fit");
  assert.match(r.rejected.find((x) => x.c.id === r.leans[0].id)!.reason, /card is full/);

  // the daily risk cap can do the same: ~2u picks hit strict's 5u cap after two
  const big = [0.6, 0.599, 0.598].map((p, i) => cand({ modelProb: p, gameId: `CAP${i}` }));
  const r2 = selectCard({ cands: big, discipline: "strict" });
  assert.equal(r2.card.length, 2);
  assert.equal(r2.exposure, 4);
  assert.equal(r2.leans.length, 1);
  assert.match(r2.rejected.find((x) => x.c.id === r2.leans[0].id)!.reason, /daily risk cap/);
});

test("near-misses: a candidate far below fair value is not a 'near' miss", () => {
  const near = cand({ modelProb: 0.515, gameId: "N1" }); // EV about -1.7%?  (just outside the cut)
  const close = cand({ modelProb: 0.523, gameId: "N2" }); // essentially break-even
  const awful = cand({ modelProb: 0.45, gameId: "N3" }); // EV about -14%
  const r = selectCard({ cands: [near, close, awful], discipline: "standard" });
  const shown = nearMisses(r.rejected, 6).map((x) => x.c.id);
  assert.ok(shown.includes(close.id), "break-even is a genuine near-miss");
  assert.ok(!shown.includes(awful.id), "−14% EV is not near anything");
});

// ---------------------------------------------------------------------------
// what is already on the ledger
// ---------------------------------------------------------------------------
const seed = (eventId: string, cluster: string, units: number, grade: Candidate["grade"] = { side: "home", line: -3.5 }) => ({
  sport: "nba", eventId, cluster, units, grade,
});

test("ledger: bets that already exist do NOT use up this card's pick limit", () => {
  // strict allows 3 picks. Three bets already exist on OTHER games; three new ones must still fit.
  const existing = ["X1", "X2", "X3"].map((g) => seed(g, "side", 1));
  const fresh = [0.546, 0.545, 0.544].map((p, i) => cand({ modelProb: p, gameId: `NEW${i}` }));
  const withLedger = selectCard({ cands: fresh, discipline: "strict", ledger: existing });
  assert.equal(withLedger.card.length, 3, "duplicates elsewhere spent none of the slots");
  // and the daily risk cap is this run's own: existing exposure does not eat into it
  assert.equal(withLedger.exposure, 3);
});

test("ledger: an angle that is already taken is closed, whether or not the bet was staked", () => {
  const spread = cand({ modelProb: 0.537, gameId: "T1", cluster: "side" });
  const total = cand({ modelProb: 0.537, gameId: "T1", cluster: "total", category: "total", bucket: bucketOf("nba", "total") });
  const r = selectCard({ cands: [spread, total], discipline: "standard", ledger: [seed("T1", "side", 1)] });
  assert.deepEqual(r.card.map((c) => c.id), [total.id], "the side is taken; the total is still open");
  assert.match(r.rejected.find((x) => x.c.id === spread.id)!.reason, /already covers this angle/);
  // an unstaked lean also holds its angle
  const r2 = selectCard({ cands: [cand({ modelProb: 0.537, gameId: "T2", cluster: "side" })], discipline: "standard", ledger: [seed("T2", "side", 0)] });
  assert.equal(r2.card.length, 0);
});

test("ledger: per-game limits are cumulative across runs (they used to reset every run)", () => {
  // two staked bets already on this game; the per-game pick limit is 2
  const a = cand({ modelProb: 0.537, gameId: "P1", cluster: "newangle" });
  const r = selectCard({ cands: [a], discipline: "standard", ledger: [seed("P1", "a", 0.5), seed("P1", "b", 0.5)] });
  assert.equal(r.card.length, 0);
  assert.match(r.rejected[0].reason, /per-game pick limit/);
  // an unstaked lean does not count as one of the two
  const r2 = selectCard({ cands: [cand({ modelProb: 0.537, gameId: "P2", cluster: "z" })], discipline: "standard", ledger: [seed("P2", "a", 0.5), seed("P2", "b", 0)] });
  assert.equal(r2.card.length, 1);

  // and so is the 2u-per-game risk cap: 1.5u already on the game leaves room for 0.5u only
  const big = cand({ modelProb: 0.545, gameId: "R1", cluster: "z" }); // sizes to 1u
  const r3 = selectCard({ cands: [big], discipline: "standard", ledger: [seed("R1", "a", 1.5)] });
  assert.equal(r3.card.length, 0);
  assert.match(r3.rejected[0].reason, /more than 2u on one game/);
  const r4 = selectCard({ cands: [cand({ modelProb: 0.537, gameId: "R2", cluster: "z" })], discipline: "standard", ledger: [seed("R2", "a", 1.5)] });
  assert.equal(r4.card.length, 1, "a 0.5u bet still fits under the cap");
});

test("ledger: a new fight pick cannot contradict one already placed", () => {
  const mk = (mma: NonNullable<Candidate["grade"]["mma"]>, category: Candidate["category"], cluster: string, side: Candidate["grade"]["side"]) =>
    cand({
      gameId: "F1", category, cluster, modelProb: 0.66, odds: -160, priceSource: "model", trust: 0.4, agree: 2,
      grade: { side, line: null, segment: "FIGHT", mma }, bucket: bucketOf("ufc", category),
    });
  const distanceYes = mk({ kind: "distance", yes: true }, "fight_distance", "duration", "over");
  const existingKo = seed("F1", "result", 0.75, { side: "home", line: null, mma: { kind: "method", fighter: "home", method: "ko" } });
  const r = selectCard({ cands: [distanceYes], discipline: "loose", ledger: [existingKo] });
  assert.equal(r.card.length, 0);
  assert.match(r.rejected[0].reason, /contradicts/);
  // …whereas a compatible bet is fine
  const distanceNo = mk({ kind: "distance", yes: false }, "fight_distance", "duration", "under");
  assert.equal(selectCard({ cands: [distanceNo], discipline: "loose", ledger: [existingKo] }).card.length, 1);
});
