import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMmaModel,
  classKey,
  halfLine,
  legacyFromModel,
  negBinCdf,
  pFinishSpread,
  pGoesDistance,
  pMethod,
  pReach,
  pRoundsOver,
  pSigStrikesOver,
  pTakedownsOver,
  pWinByFinish,
  roundLines,
  sigStrikesBaseline,
  sigStrikesMean,
  type MmaBoutInput,
  type MmaModel,
} from "../src/lib/mma-model";
import type { FighterProfile } from "../src/lib/fighter-stats";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`);

function profile(over: Partial<FighterProfile> = {}): FighterProfile {
  return {
    athleteId: "1",
    displayName: "Test Fighter",
    hasStats: true,
    reach: 72,
    height: 70,
    stance: "Orthodox",
    strikeLPM: 3.4,
    strikeAccuracy: 45,
    strikeDefense: 55,
    takedownAvg: 0.9,
    takedownAccuracy: 40,
    takedownDefense: 62,
    submissionAvg: 0.5,
    koTkoPct: 35,
    decisionPct: 30,
    finishRate: 0.5,
    ...over,
  };
}

function bout(over: Partial<MmaBoutInput> = {}): MmaBoutInput {
  return {
    weightClass: "Welterweight",
    scheduledRounds: 3,
    promotion: "ufc",
    away: { record: "12-3-0", profile: profile() },
    home: { record: "12-3-0", profile: profile() },
    ...over,
  };
}

function checkDistribution(m: MmaModel) {
  near(m.pAway + m.pHome, 1);
  near(m.pFinish + m.pDecision, 1);
  near(m.finishByRound.reduce((s, x) => s + x, 0), m.pFinish);
  near(m.scenarios.reduce((s, x) => s + x.prob, 0), 1);
  for (const side of ["home", "away"] as const) {
    const t = m.method[side];
    near(t.ko + t.sub + t.dec, side === "home" ? m.pHome : m.pAway);
  }
  near(
    pMethod(m, "home", "ko") + pMethod(m, "home", "sub") + pMethod(m, "home", "dec") +
      pMethod(m, "away", "ko") + pMethod(m, "away", "sub") + pMethod(m, "away", "dec"),
    1,
  );
  // decision probability from the method table equals the duration model
  near(m.method.home.dec + m.method.away.dec, m.pDecision, 1e-9);
}

test("division parsing", () => {
  assert.equal(classKey("Heavyweight"), "hw");
  assert.equal(classKey("Light Heavyweight"), "lhw");
  assert.equal(classKey("Lightweight"), "lw");
  assert.equal(classKey("Women's Strawweight"), "straw");
  assert.equal(classKey("Women's Bantamweight"), "w_bw");
  assert.equal(classKey("Flyweight"), "flw");
  assert.equal(classKey("Catchweight"), "default");
});

test("joint distribution is internally consistent (3 and 5 rounds)", () => {
  checkDistribution(buildMmaModel(bout()));
  checkDistribution(buildMmaModel(bout({ scheduledRounds: 5, weightClass: "Heavyweight" })));
  checkDistribution(buildMmaModel(bout({ promotion: "dwcs" })));
  checkDistribution(
    buildMmaModel(bout({ away: { record: "5-0", profile: null }, home: { record: "20-9", profile: null } })),
  );
});

test("symmetric fighters are a coin flip", () => {
  const m = buildMmaModel(bout());
  near(m.pHome, 0.5, 0.01);
});

test("win probability is bounded and moves the right way", () => {
  const strong = buildMmaModel(
    bout({
      away: { record: "25-1", profile: profile({ strikeLPM: 6.5, takedownAvg: 3 }) },
      home: { record: "6-6", profile: profile({ strikeLPM: 2.0, strikeDefense: 40 }) },
    }),
  );
  assert.ok(strong.pAway > 0.65, `pAway=${strong.pAway}`);
  assert.ok(strong.pAway <= 0.78 + 1e-9, "never claims more than 78%");
  assert.ok(strong.pHome >= 0.22 - 1e-9);
});

test("no fighter stats → record-only model, flagged", () => {
  const m = buildMmaModel(bout({ away: { record: "10-2", profile: null }, home: { record: "10-2", profile: profile() } }));
  assert.equal(m.statsUsed, false);
  checkDistribution(m);
});

test("division and format move finish probability sensibly", () => {
  const hw = buildMmaModel(bout({ weightClass: "Heavyweight" }));
  const straw = buildMmaModel(bout({ weightClass: "Women's Strawweight" }));
  assert.ok(hw.pFinish > straw.pFinish + 0.2, `${hw.pFinish} vs ${straw.pFinish}`);

  const three = buildMmaModel(bout());
  const five = buildMmaModel(bout({ scheduledRounds: 5 }));
  assert.ok(five.pFinish < three.pFinish, "5-round main events finish a bit less");

  const ufc = buildMmaModel(bout());
  const dwcs = buildMmaModel(bout({ promotion: "dwcs" }));
  assert.ok(dwcs.pFinish > ufc.pFinish, "DWCS prospects finish more");
});

test("fighter tendencies flow into method of victory", () => {
  const base = buildMmaModel(bout());
  const knockoutArtist = buildMmaModel(
    bout({
      away: { record: "12-3-0", profile: profile({ koTkoPct: 75, decisionPct: 5 }) },
      home: { record: "12-3-0", profile: profile({ strikeDefense: 40 }) },
    }),
  );
  assert.ok(
    pMethod(knockoutArtist, "away", "ko") > pMethod(base, "away", "ko"),
    "KO threat vs a leaky chin raises P(KO)",
  );
  const grappler = buildMmaModel(
    bout({
      away: { record: "12-3-0", profile: profile({ submissionAvg: 2.2, takedownAvg: 4 }) },
      home: { record: "12-3-0", profile: profile({ takedownDefense: 40 }) },
    }),
  );
  assert.ok(pMethod(grappler, "away", "sub") > pMethod(base, "away", "sub"));
});

test("reach / total-round probabilities are monotone and consistent", () => {
  const m = buildMmaModel(bout({ scheduledRounds: 5, weightClass: "Middleweight" }));
  near(pReach(m, 1), 1);
  near(pReach(m, 2), 1 - m.finishByRound[0]);
  for (let k = 2; k <= 5; k++) assert.ok(pReach(m, k) <= pReach(m, k - 1) + 1e-12);
  assert.equal(pReach(m, 6), 0);

  const lines = roundLines(5);
  assert.deepEqual(lines, [0.5, 1.5, 2.5, 3.5, 4.5]);
  let prev = 1;
  for (const L of lines) {
    const p = pRoundsOver(m, L);
    assert.ok(p <= prev + 1e-12, `over ${L} must not exceed over the previous line`);
    assert.ok(p > 0 && p < 1);
    prev = p;
  }
  // the highest line is cleared by a decision plus late finishes
  assert.ok(pRoundsOver(m, 4.5) >= pGoesDistance(m) - 1e-12);
  assert.ok(pRoundsOver(m, 4.5) <= pReach(m, 5) + 1e-12);
  // a line the bout can't reach is not offered
  assert.ok(Number.isNaN(pRoundsOver(buildMmaModel(bout()), 3.5)));
  assert.ok(Number.isNaN(pRoundsOver(buildMmaModel(bout()), 4.5)));
});

test("typical UFC three-rounder lands near real-world totals", () => {
  const m = buildMmaModel(bout({ weightClass: "Lightweight" }));
  // books price over 0.5 around -600/-800, over 1.5 around -250, over 2.5 near even
  assert.ok(pRoundsOver(m, 0.5) > 0.85 && pRoundsOver(m, 0.5) < 0.95, `${pRoundsOver(m, 0.5)}`);
  assert.ok(pRoundsOver(m, 1.5) > 0.62 && pRoundsOver(m, 1.5) < 0.8, `${pRoundsOver(m, 1.5)}`);
  assert.ok(pRoundsOver(m, 2.5) > 0.45 && pRoundsOver(m, 2.5) < 0.65, `${pRoundsOver(m, 2.5)}`);
  assert.ok(m.pDecision > 0.4 && m.pDecision < 0.6, `decision=${m.pDecision}`);
});

test("finish handicap: -1.5 and the opponent's +1.5 are complements", () => {
  const m = buildMmaModel(
    bout({
      away: { record: "20-2", profile: profile({ koTkoPct: 60 }) },
      home: { record: "9-5", profile: profile() },
    }),
  );
  near(pFinishSpread(m, "home", -1.5) + pFinishSpread(m, "away", 1.5), 1);
  near(pFinishSpread(m, "away", -1.5) + pFinishSpread(m, "home", 1.5), 1);
  // +1.5 only loses to a finish, so it is at least the plain moneyline
  assert.ok(pFinishSpread(m, "away", 1.5) >= m.pAway - 1e-12);
  // -1.5 is harder than the moneyline
  assert.ok(pFinishSpread(m, "away", -1.5) <= m.pAway + 1e-12);
  near(pWinByFinish(m, "away"), pMethod(m, "away", "ko") + pMethod(m, "away", "sub"));
});

test("negative binomial cdf", () => {
  near(negBinCdf(0, 2, 2), 0.25, 1e-12); // (k/(k+mean))^k
  assert.equal(negBinCdf(-1, 2, 2), 0);
  assert.equal(negBinCdf(5, 0, 2), 1);
  let prev = 0;
  for (let x = 0; x < 60; x++) {
    const c = negBinCdf(x, 20, 6);
    assert.ok(c >= prev - 1e-12);
    prev = c;
  }
  assert.ok(negBinCdf(400, 20, 6) > 0.999999);
  // mean of the distribution is roughly recovered
  let mean = 0;
  for (let x = 0; x < 300; x++) mean += (1 - negBinCdf(x, 20, 6));
  near(mean, 20, 0.05);
});

test("significant strikes: monotone in the line, responsive to volume", () => {
  const volume = buildMmaModel(bout({ away: { record: "12-3", profile: profile({ strikeLPM: 6 }) } }));
  const slow = buildMmaModel(bout({ away: { record: "12-3", profile: profile({ strikeLPM: 2 }) } }));
  let prev = 1;
  for (const L of [10.5, 30.5, 50.5, 70.5, 90.5]) {
    const p = pSigStrikesOver(volume, "away", L);
    assert.ok(p >= 0 && p <= 1);
    assert.ok(p <= prev + 1e-12, `non-increasing at ${L}`);
    prev = p;
  }
  assert.ok(pSigStrikesOver(volume, "away", 50.5) > pSigStrikesOver(slow, "away", 50.5));
  assert.ok(sigStrikesMean(volume, "away") > sigStrikesMean(slow, "away"));
  // a volume striker's mean sits above a division-average line-setter
  assert.ok(sigStrikesBaseline(volume, "away") > sigStrikesBaseline(slow, "away"));
});

test("opponent defence shifts expected strikes", () => {
  const vsLeaky = buildMmaModel(bout({ home: { record: "12-3", profile: profile({ strikeDefense: 40 }) } }));
  const vsTight = buildMmaModel(bout({ home: { record: "12-3", profile: profile({ strikeDefense: 70 }) } }));
  assert.ok(sigStrikesMean(vsLeaky, "away") > sigStrikesMean(vsTight, "away"));
});

test("takedowns: wrestlers clear 0.5 far more often than strikers", () => {
  const wrestler = buildMmaModel(bout({ away: { record: "12-3", profile: profile({ takedownAvg: 4.5 }) } }));
  const striker = buildMmaModel(bout({ away: { record: "12-3", profile: profile({ takedownAvg: 0.2 }) } }));
  assert.ok(pTakedownsOver(wrestler, "away", 0.5) > 0.6);
  assert.ok(pTakedownsOver(striker, "away", 0.5) < 0.2);
  assert.ok(pTakedownsOver(wrestler, "away", 2.5) < pTakedownsOver(wrestler, "away", 0.5));
  // stout takedown defence suppresses a wrestler
  const stuffed = buildMmaModel(
    bout({
      away: { record: "12-3", profile: profile({ takedownAvg: 4.5 }) },
      home: { record: "12-3", profile: profile({ takedownDefense: 90 }) },
    }),
  );
  assert.ok(pTakedownsOver(stuffed, "away", 0.5) < pTakedownsOver(wrestler, "away", 0.5));
});

test("half lines never land on an integer", () => {
  assert.equal(halfLine(52.3), 52.5);
  assert.equal(halfLine(52.9), 52.5);
  assert.equal(halfLine(0.1), 0.5);
  assert.equal(halfLine(0), 0.5);
});

test("legacy shape for the slate board stays valid", () => {
  const m = buildMmaModel(bout({ scheduledRounds: 5 }));
  const l = legacyFromModel(m);
  assert.equal(l.roundLine, 2.5);
  near(l.pHome + l.pAway, 1);
  assert.ok(Number.isInteger(l.fairHomeML) && Number.isInteger(l.fairFinish));
  const l3 = legacyFromModel(buildMmaModel(bout()));
  assert.equal(l3.roundLine, 1.5);
});
