import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_PAIRED, calibration, scoreForecasts, scoreRows, type ScoredRow } from "../src/lib/forecast";

const close = (a: number | null, b: number, eps = 1e-9): boolean => a != null && Math.abs(a - b) < eps;
const row = (pModel: number, pMarket: number | null, win: boolean, sport = "nba"): ScoredRow => ({ sport, pModel, pMarket, outcome: win ? "win" : "loss" });
/** `wins` winners and `losses` losers at the same probabilities */
const many = (wins: number, losses: number, pModel: number, pMarket: number | null, sport = "nba"): ScoredRow[] => [
  ...Array.from({ length: wins }, () => row(pModel, pMarket, true, sport)),
  ...Array.from({ length: losses }, () => row(pModel, pMarket, false, sport)),
];

test("Brier: saying 50% every time scores 0.25, a confident correct call scores near 0", () => {
  assert.ok(close(scoreRows(many(5, 5, 0.5, null)).brier, 0.25));
  assert.ok(close(scoreRows([row(0.9, null, true)]).brier, 0.01));
  assert.ok(close(scoreRows([row(0.9, null, false)]).brier, 0.81), "and a confident miss is punished hard");
});

test("hit rate and average claimed probability", () => {
  const s = scoreRows([row(0.6, null, true), row(0.7, null, true), row(0.8, null, false), row(0.5, null, true)]);
  assert.equal(s.n, 4);
  assert.equal(s.hits, 3);
  assert.ok(close(s.hitRate, 0.75));
  assert.ok(close(s.avgP, 0.65));
});

test("model vs market on the same games — hand-computed", () => {
  // (0.8 vs market 0.6, the pick won) and (0.7 vs market 0.5, the pick lost)
  const s = scoreRows([row(0.8, 0.6, true), row(0.7, 0.5, false)]);
  // model: ((0.2)² + (0.7)²) / 2 = 0.265    market: ((0.4)² + (0.5)²) / 2 = 0.205
  assert.ok(close(s.brierModel, 0.265));
  assert.ok(close(s.brierMarket, 0.205));
  assert.ok(close(s.edge, -0.06), "market − model: negative means the market was better");
  assert.equal(s.nPaired, 2);
});

test("only games the market also priced are compared with it", () => {
  const s = scoreRows([row(0.8, 0.6, true), row(0.7, null, false)]);
  assert.equal(s.n, 2);
  assert.equal(s.nPaired, 1);
  assert.ok(close(s.brier, ((0.2) ** 2 + (0.7) ** 2) / 2), "our own Brier still covers every game");
  assert.ok(close(s.brierModel, 0.04), "the comparison uses the paired game only");
});

test("verdict: too early below the paired-game minimum, whatever the numbers look like", () => {
  const s = scoreRows(many(MIN_PAIRED - 1, 0, 0.9, 0.5));
  assert.equal(s.nPaired, MIN_PAIRED - 1);
  assert.equal(s.verdict, "too early");
  assert.equal(scoreRows([]).verdict, "too early");
  assert.equal(scoreRows([]).n, 0);
  assert.equal(scoreRows([]).brier, null);
});

test("verdict: with no market probabilities at all there is nothing to compare against", () => {
  assert.equal(scoreRows(many(40, 20, 0.6, null, "ufc")).verdict, "no market to compare");
});

test("verdict: clearly better probabilities beat the market, clearly worse trail it, identical ones tie", () => {
  // The pick wins 70 % of the time. We said 70 %, the market said 55 %: our Brier is 0.21 vs 0.2325.
  const better = scoreRows(many(700, 300, 0.7, 0.55));
  assert.ok(close(better.edge, 0.0225), String(better.edge));
  assert.equal(better.verdict, "beats the market");

  const worse = scoreRows(many(700, 300, 0.55, 0.7));
  assert.ok(close(worse.edge, -0.0225));
  assert.equal(worse.verdict, "trails the market");

  // same probabilities as the market → no difference, however many games
  const same = scoreRows(many(70, 30, 0.6, 0.6));
  assert.equal(same.edge, 0);
  assert.equal(same.verdict, "no clear difference");
});

test("verdict: a small edge on a small sample is not called either way", () => {
  // the same 0.0225 edge as above, but over only 40 games the noise swamps it
  const s = scoreRows(many(28, 12, 0.7, 0.55));
  assert.equal(s.nPaired, 40);
  assert.ok(close(s.edge, 0.0225));
  assert.equal(s.verdict, "no clear difference");
});

test("disagreements: how often we were right when the market favoured the other side", () => {
  const s = scoreRows([row(0.6, 0.45, true), row(0.55, 0.4, false), row(0.7, 0.65, true), row(0.52, null, true)]);
  assert.equal(s.disagreed, 2);
  assert.equal(s.disagreedRight, 1);
});

test("hit rate of our picks vs always backing the market's favourite, on the same games", () => {
  const s = scoreRows([
    row(0.6, 0.6, true), // market favourite = our pick, it won   → market hit
    row(0.6, 0.6, false), // …it lost                              → market miss
    row(0.55, 0.4, true), // market favoured the other side; our pick won → market miss
    row(0.55, 0.4, false), // …our pick lost, so the market's favourite won → market hit
  ]);
  assert.ok(close(s.marketHitRatePaired, 0.5));
  assert.ok(close(s.modelHitRatePaired, 0.5));
  const more = scoreRows([row(0.6, 0.45, true), row(0.6, 0.45, true), row(0.6, 0.45, false)]);
  assert.ok(close(more.modelHitRatePaired, 2 / 3));
  assert.ok(close(more.marketHitRatePaired, 1 / 3), "the market backed the other side every time");
});

test("calibration bins: edges, counts, and predicted vs actual", () => {
  const rows = [
    row(0.5, null, true), row(0.5499, null, false), // 50–55 %
    row(0.55, null, true), row(0.59, null, true), row(0.58, null, false), // 55–60 %
    row(0.99, null, true), // top band, reported as 80–100 %
  ];
  const bins = calibration(rows);
  assert.deepEqual(bins.map((b) => [b.lo, b.n]), [[0.5, 2], [0.55, 3], [0.8, 1]]);
  assert.equal(bins[2].hi, 1);
  assert.ok(close(bins[0].actual, 0.5));
  assert.ok(close(bins[1].actual, 2 / 3));
  assert.ok(close(bins[1].predicted, (0.55 + 0.59 + 0.58) / 3));
  assert.deepEqual(calibration([]), []);
});

test("the scoreboard groups by sport, biggest sample first, and reports the whole book too", () => {
  const sb = scoreForecasts([...many(3, 1, 0.6, 0.58, "nba"), ...many(1, 1, 0.65, null, "ufc"), ...many(5, 4, 0.6, 0.6, "nhl")]);
  assert.deepEqual(sb.bySport.map((s) => [s.sport, s.score.n]), [["nhl", 9], ["nba", 4], ["ufc", 2]]);
  assert.equal(sb.overall.n, 15);
  assert.equal(sb.overall.hits, 9);
  assert.equal(sb.calibration.reduce((s, b) => s + b.n, 0), 15);
  assert.equal(scoreForecasts([]).bySport.length, 0);
});
