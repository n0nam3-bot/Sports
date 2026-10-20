import { test } from "node:test";
import assert from "node:assert/strict";
import { isContenderSeries, parsePredictor } from "../src/lib/espn";
import { parseFightStatLine } from "../src/lib/fighter-stats";

// ---------------------------------------------------------------------------
// post-fight statistics
// ---------------------------------------------------------------------------
test("fight stats: a stat carrying name AND displayName still matches (the bug that left strikes picks ungraded)", () => {
  const payload = {
    splits: {
      categories: [
        { name: "striking", stats: [{ name: "sigStrikesLanded", displayName: "Sig. Strikes Landed", abbreviation: "SSL", value: 61 }] },
        { name: "grappling", stats: [{ name: "takedownsLanded", displayName: "Takedowns Landed", value: 2 }] },
      ],
    },
  };
  assert.deepEqual(parseFightStatLine(payload), { sigStrikesLanded: 61, takedownsLanded: 2 });
});

test("fight stats: tolerates other plausible shapes", () => {
  // identifier only in displayName
  assert.deepEqual(
    parseFightStatLine({ stats: [{ displayName: "Significant Strikes Landed", value: 40 }, { displayName: "Takedowns", value: 1 }] }),
    { sigStrikesLanded: 40, takedownsLanded: 1 },
  );
  // numbers delivered as strings
  assert.deepEqual(
    parseFightStatLine({ categories: [{ stats: [{ name: "sigStrikesLanded", value: "33" }, { name: "takedownsLanded", value: "0" }] }] }),
    { sigStrikesLanded: 33, takedownsLanded: 0 },
  );
  // value only in displayValue
  assert.equal(parseFightStatLine({ stats: [{ name: "sigStrikesLanded", displayValue: "47 of 90" }] }).sigStrikesLanded, 47);
  // deeply nested
  assert.equal(parseFightStatLine({ a: { b: [{ c: { stats: [{ name: "sigStrikes", value: 12 }] } }] } }).sigStrikesLanded, 12);
  // looser naming falls back to a pattern
  assert.equal(parseFightStatLine({ stats: [{ name: "significantStrikesLandedTotal", value: 55 }] }).sigStrikesLanded, 55);
  assert.equal(parseFightStatLine({ stats: [{ name: "totalSigStrikes", value: 48 }, { name: "totalTakedowns", value: 2 }] }).sigStrikesLanded, 48);
  assert.equal(parseFightStatLine({ stats: [{ name: "totalTakedowns", value: 2 }] }).takedownsLanded, 2);
});

test("fight stats: never mistakes attempts, accuracy, targets or defence for the count", () => {
  const p = {
    stats: [
      { name: "sigStrikesAttempted", value: 120 },
      { name: "sigStrikeAccuracy", value: 50 },
      { name: "sigStrikesLandedHead", displayName: "Head Strikes Landed", value: 30 },
      { name: "sigStrikesLandedDistance", value: 40 },
      { name: "strikeDefense", value: 60 },
      { name: "takedownsAttempted", value: 5 },
      { name: "takedownAccuracy", value: 40 },
      { name: "takedownDefense", value: 80 },
      { name: "takedownsPer15", value: 1.2 },
    ],
  };
  assert.deepEqual(parseFightStatLine(p), { sigStrikesLanded: null, takedownsLanded: null });
  // …and picks the real one when it is present among the decoys
  const mixed = { stats: [...p.stats, { name: "sigStrikesLanded", value: 77 }, { name: "takedownsLanded", value: 3 }] };
  assert.deepEqual(parseFightStatLine(mixed), { sigStrikesLanded: 77, takedownsLanded: 3 });
});

test("fight stats: missing / empty payloads yield null (the pick stays pending, never mis-graded)", () => {
  assert.deepEqual(parseFightStatLine({}), { sigStrikesLanded: null, takedownsLanded: null });
  assert.deepEqual(parseFightStatLine(null), { sigStrikesLanded: null, takedownsLanded: null });
  assert.deepEqual(parseFightStatLine({ stats: [{ name: "sigStrikesLanded" }] }), { sigStrikesLanded: null, takedownsLanded: null });
});

// ---------------------------------------------------------------------------
// ESPN's matchup predictor
// ---------------------------------------------------------------------------
test("predictor: accepts ESPN's string percentages and rejects nonsense", () => {
  assert.deepEqual(parsePredictor({ predictor: { homeTeam: { gameProjection: "78.0" }, awayTeam: { gameProjection: "22.0" } } }), { homeWinPct: 78, awayWinPct: 22 });
  // only one side published → infer the other
  assert.deepEqual(parsePredictor({ predictor: { homeTeam: { gameProjection: "60" } } }), { homeWinPct: 60, awayWinPct: 40 });
  assert.deepEqual(parsePredictor({ predictor: { awayTeam: { gameProjection: "35" } } }), { homeWinPct: 65, awayWinPct: 35 });
  // inconsistent pair, out of range, absent
  assert.equal(parsePredictor({ predictor: { homeTeam: { gameProjection: "90" }, awayTeam: { gameProjection: "90" } } }), null);
  assert.equal(parsePredictor({ predictor: { homeTeam: { gameProjection: "100" }, awayTeam: { gameProjection: "0" } } }), null);
  assert.equal(parsePredictor({ predictor: { homeTeam: { gameProjection: "abc" } } }), null);
  assert.equal(parsePredictor({}), null);
  assert.equal(parsePredictor(null), null);
});

// ---------------------------------------------------------------------------
// DWCS vs UFC
// ---------------------------------------------------------------------------
test("Contender Series cards are recognised by name", () => {
  for (const name of ["Dana White's Contender Series: Week 4", "DANA WHITE'S CONTENDER SERIES 2026", "DWCS 9", "Contender Series Season 9 Week 1"]) {
    assert.equal(isContenderSeries({ name }), true, name);
  }
  assert.equal(isContenderSeries({ name: "UFC 310: Pantoja vs. Asakura" }), false);
  assert.equal(isContenderSeries({ name: "UFC Fight Night: Test Card", shortName: "UFC FN" }), false);
  assert.equal(isContenderSeries({ name: "PFL 5", shortName: "PFL" }), false);
  assert.equal(isContenderSeries({ shortName: "DWCS" }), true);
  assert.equal(isContenderSeries(null), false);
});
