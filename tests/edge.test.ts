import { test } from "node:test";
import assert from "node:assert/strict";
import {
  devigTwoWay,
  evPerUnit,
  fairAmerican,
  impliedProb,
  isAmerican,
  kellyFraction,
  minAcceptableAmerican,
  normCdf,
  normInv,
  profitPerUnit,
  settledProfit,
  shiftProb,
  stakeUnits,
} from "../src/lib/edge";

const near = (a: number, b: number, eps = 1e-4) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`);

test("implied probability and payout", () => {
  near(impliedProb(-110), 110 / 210);
  near(impliedProb(150), 0.4);
  near(impliedProb(-100), 0.5);
  near(impliedProb(100), 0.5);
  near(profitPerUnit(-110), 100 / 110);
  near(profitPerUnit(150), 1.5);
});

test("fair american price round-trips with implied probability", () => {
  assert.equal(fairAmerican(0.6), -150);
  assert.equal(fairAmerican(0.4), 150);
  assert.equal(fairAmerican(0.5), 100);
  for (const p of [0.12, 0.3, 0.45, 0.55, 0.7, 0.9]) {
    near(impliedProb(fairAmerican(p)), p, 0.006);
  }
  // extreme inputs are clamped, never NaN / Infinity
  assert.ok(Number.isFinite(fairAmerican(0)));
  assert.ok(Number.isFinite(fairAmerican(1)));
});

test("de-vig removes the margin and sums to one", () => {
  const [a, b] = devigTwoWay(-110, -110);
  near(a, 0.5);
  near(b, 0.5);
  const [fav, dog] = devigTwoWay(-200, 170);
  near(fav + dog, 1);
  near(fav, 0.6429, 1e-3);
  // the de-vigged favourite is *less* likely than its raw implied price
  assert.ok(fav < impliedProb(-200));
});

test("normal cdf / inverse are consistent", () => {
  near(normCdf(0), 0.5);
  near(normCdf(1.96), 0.975, 1e-3);
  near(normInv(0.975), 1.95996, 1e-3);
  for (let p = 0.001; p < 1; p += 0.0137) {
    near(normCdf(normInv(p)), p, 1e-6);
  }
});

test("shiftProb keeps the market as the prior and is monotonic", () => {
  near(shiftProb(0.5, 0, 12), 0.5);
  near(shiftProb(0.5, 12, 12), normCdf(1), 1e-4);
  near(shiftProb(0.5, -12, 12), normCdf(-1), 1e-4);
  assert.ok(shiftProb(0.5, 1, 12) > 0.5);
  assert.ok(shiftProb(0.5, 2, 12) > shiftProb(0.5, 1, 12));
  // a 1-point NBA nudge is worth about 3 probability points, not 20
  const moved = shiftProb(0.5, 1, 12) - 0.5;
  assert.ok(moved > 0.025 && moved < 0.04, `moved=${moved}`);
  // degenerate sigma leaves p untouched
  assert.equal(shiftProb(0.55, 3, 0), 0.55);
});

test("expected value: break-even at -110 is 52.38%", () => {
  near(evPerUnit(110 / 210, -110), 0, 1e-9);
  assert.ok(evPerUnit(0.55, -110) > 0);
  assert.ok(evPerUnit(0.52, -110) < 0);
  // a push neither wins nor loses
  near(evPerUnit(0.5, 100, 0.2), 0.5 - 0.3);
  assert.ok(evPerUnit(0.48, -110, 0.06) < 0);
});

test("kelly fraction", () => {
  near(kellyFraction(0.55, -110), 0.05 / (100 / 110), 1e-4);
  assert.equal(kellyFraction(0.5, -110), 0);
  assert.equal(kellyFraction(0.3, 200), 0); // 30% at +200 is below break-even (33.3%)
  assert.ok(kellyFraction(0.9, 100) <= 1);
  // pushes make the same edge slightly more valuable per risked unit
  assert.ok(kellyFraction(0.55, -110, 0.05) > 0);
});

test("stake sizing: scales with edge, rounds DOWN, honours min and max", () => {
  // 55% at -110 → full Kelly 5.5% → quarter Kelly 1.375u → floored to 1.25u
  assert.equal(stakeUnits({ pWin: 0.55, american: -110 }), 1.25);
  // a thin edge earns a small ticket
  assert.equal(stakeUnits({ pWin: 0.5345, american: -110 }), 0.5);
  // below the minimum ticket → no bet at all
  assert.equal(stakeUnits({ pWin: 0.528, american: -110 }), 0);
  // no edge → no bet
  assert.equal(stakeUnits({ pWin: 0.52, american: -110 }), 0);
  // huge edge is capped
  assert.equal(stakeUnits({ pWin: 0.7, american: 100 }), 2);
  assert.equal(stakeUnits({ pWin: 0.7, american: 100, maxUnits: 1 }), 1);
  // trust haircut shrinks the ticket
  const full = stakeUnits({ pWin: 0.58, american: -110 });
  const half = stakeUnits({ pWin: 0.58, american: -110, uncertainty: 0.5 });
  assert.ok(half < full, `${half} !< ${full}`);
  // sizing is a multiple of the step
  for (const p of [0.54, 0.56, 0.6, 0.65]) {
    const u = stakeUnits({ pWin: p, american: -110 });
    assert.equal(Math.round(u * 4) / 4, u);
  }
  // garbage in → 0 out
  assert.equal(stakeUnits({ pWin: NaN, american: -110 }), 0);
});

test("a heavier favourite needs a bigger probability to earn the same stake", () => {
  const dog = stakeUnits({ pWin: 0.45, american: 140 }); // implied 41.7%
  const chalk = stakeUnits({ pWin: 0.7, american: -300 }); // implied 75% → negative edge
  assert.ok(dog > 0);
  assert.equal(chalk, 0);
});

test("minimum acceptable price keeps a cushion below the model probability", () => {
  const fair = fairAmerican(0.65);
  const min = minAcceptableAmerican(0.65, 0.035);
  assert.ok(Math.abs(min) < Math.abs(fair), "the floor is a shorter price than fair");
  assert.equal(fair, -186);
  assert.equal(min, -160);
  // at the floor the bet still has positive EV against the model
  assert.ok(evPerUnit(0.65, min) > 0.03);
});

test("settled profit", () => {
  near(settledProfit("win", 1, -110), 100 / 110);
  near(settledProfit("win", 2, 150), 3);
  assert.equal(settledProfit("loss", 1.5, -110), -1.5);
  assert.equal(settledProfit("push", 1, -110), 0);
  assert.equal(settledProfit("void", 1, -110), 0);
  assert.equal(settledProfit("pending", 1, -110), 0);
});

test("american price validation", () => {
  assert.ok(isAmerican(-110));
  assert.ok(isAmerican(250));
  assert.ok(!isAmerican(0));
  assert.ok(!isAmerican(-50));
  assert.ok(!isAmerican(99));
  assert.ok(!isAmerican(1.5));
  assert.ok(!isAmerican("-110"));
  assert.ok(!isAmerican(NaN));
});
