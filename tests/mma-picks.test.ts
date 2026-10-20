import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFilter, mmaMarketKey } from "../src/lib/markets";
import { evaluateBout } from "../src/lib/mma-picks";
import { evPerUnit, fairAmerican, impliedProb } from "../src/lib/edge";
import { bout, idGen, odds, profile } from "./helpers";
import { selectCard } from "../src/lib/selection";

const mixed = buildFilter([]);

// A lopsided, stat-rich fight: a heavy-handed favourite vs a leaky-chinned wrestler-less opponent.
const lopsided = () =>
  bout({
    weightClass: "Heavyweight",
    awayRecord: "22-3-0",
    homeRecord: "11-6-0",
    away: profile({ athleteId: "A1", displayName: "Away Fighter", koTkoPct: 72, strikeLPM: 5.6, decisionPct: 8, takedownAvg: 0.4 }),
    home: profile({ athleteId: "H1", displayName: "Home Fighter", strikeDefense: 42, takedownDefense: 48, strikeLPM: 3.0 }),
  });

test("an average, symmetric fight produces no picks: nothing specific to say", () => {
  const g = bout();
  const { cands } = evaluateBout(g, mixed, idGen(), "standard");
  assert.equal(cands.length, 0, cands.map((c) => c.pick).join(" | "));
});

test("a lopsided fight yields picks across several markets, all consistent", () => {
  const g = lopsided();
  const { cands } = evaluateBout(g, mixed, idGen(), "loose");
  assert.ok(cands.length >= 3, `got ${cands.length}`);
  const kinds = new Set(cands.map((c) => c.grade.mma!.kind));
  assert.ok(kinds.has("ml"), "moneyline");
  for (const c of cands) {
    assert.equal(c.priceSource, "model");
    assert.equal(c.grade.segment, "FIGHT");
    assert.ok(c.grade.mma, "structured grade present");
    assert.equal(c.key, mmaMarketKey(c.grade.mma!));
    assert.deepEqual(c.grade.fightRef, { league: "ufc", cardId: "CARD1", homeId: "H1", awayId: "A1" });
    // the price floor is a SHORTER price than fair: we keep a cushion
    assert.ok(c.minOdds != null);
    assert.equal(c.odds, c.minOdds, "ledger/sizing price is the conservative floor");
    assert.ok(impliedProb(c.minOdds!) < c.modelProb, "floor still has a cushion below the model probability");
    assert.ok(impliedProb(c.minOdds!) < impliedProb(c.fairOdds), "the floor is a cheaper break-even than fair");
    assert.equal(c.fairOdds, fairAmerican(c.modelProb));
    assert.ok(c.ev > 0.02, `notional EV at the floor ${c.ev}`);
    assert.match(c.thesis, /MODEL PRICE/);
    assert.match(c.thesis, /or better/);
    assert.ok(c.modelProb <= 0.75 + 1e-9, `no heavy chalk on a model-priced pick: ${c.pick} ${c.modelProb}`);
    assert.ok(c.minOdds! >= -250, `floor ${c.minOdds} must not be steeper than -250`);
  }
});

test("each pick passes the probability floor AND the division base-rate deviation bar", () => {
  const g = lopsided();
  for (const disc of ["strict", "standard", "loose"] as const) {
    const { cands } = evaluateBout(g, mixed, idGen(), disc);
    const min = { strict: 0.04, standard: 0, loose: -0.03 }[disc];
    for (const c of cands) {
      const floor =
        { ml: 0.62, rounds: 0.62, distance: 0.62, start: 0.66, spread: 0.58, method: 0.4, sigstr: 0.58, td: 0.58 }[
          ({ ml: "ml", rounds: "rounds", distance: "distance", start_round: "start", spread: "spread", method: "method", sigstr: "sigstr", td: "td" } as const)[c.grade.mma!.kind]
        ] + min;
      assert.ok(c.modelProb >= floor - 1e-9, `${disc}: ${c.pick} p=${c.modelProb} < ${floor}`);
    }
  }
  const strict = evaluateBout(lopsided(), mixed, idGen(), "strict").cands.length;
  const loose = evaluateBout(lopsided(), mixed, idGen(), "loose").cands.length;
  assert.ok(strict <= loose, "strict never produces more than loose");
});

test("a three-round bout never offers 3.5/4.5 rounds or fight-starts-round-4/5", () => {
  const { cands } = evaluateBout(lopsided(), buildFilter(["rounds_3_5", "rounds_4_5", "fight_start_4", "fight_start_5"]), idGen(), "loose");
  assert.equal(cands.length, 0);
});

test("a five-round bout can offer every line and start-round market", () => {
  const g = bout({
    rounds: 5,
    weightClass: "Heavyweight",
    awayRecord: "22-3-0",
    homeRecord: "11-6-0",
    away: profile({ athleteId: "A1", koTkoPct: 72, strikeLPM: 5.6, decisionPct: 8 }),
    home: profile({ athleteId: "H1", strikeDefense: 42 }),
  });
  const all = evaluateBout(g, buildFilter(["rounds_0_5", "rounds_1_5", "rounds_2_5", "rounds_3_5", "rounds_4_5", "fight_start_2", "fight_start_3", "fight_start_4", "fight_start_5", "fight_distance_yes", "fight_distance_no"]), idGen(), "loose").cands;
  for (const c of all) {
    const m = c.grade.mma!;
    if (m.kind === "rounds") assert.ok(m.line <= 4.5);
    if (m.kind === "start_round") assert.ok(m.round >= 2 && m.round <= 5);
  }
  assert.ok(all.length > 0);
});

test("focused selection returns ONLY the chosen market keys", () => {
  const g = lopsided();
  const only = evaluateBout(g, buildFilter(["rounds_1_5"]), idGen(), "loose").cands;
  assert.ok(only.length <= 1);
  for (const c of only) assert.equal(c.key, "rounds_1.5");

  const ko = evaluateBout(g, buildFilter(["method_ko"]), idGen(), "loose").cands;
  for (const c of ko) {
    assert.equal(c.grade.mma!.kind, "method");
    assert.equal((c.grade.mma as { method: string }).method, "ko");
  }
  const ml = evaluateBout(g, buildFilter(["fight_winner"]), idGen(), "loose").cands;
  assert.ok(ml.every((c) => c.grade.mma!.kind === "ml"));
});

test("without ESPN fighter stats: only ML / rounds / distance / start-round, and a higher bar", () => {
  const g = bout({
    weightClass: "Heavyweight",
    awayRecord: "26-1-0",
    homeRecord: "8-7-0",
    away: null,
    home: null,
  });
  const { cands } = evaluateBout(g, mixed, idGen(), "loose");
  for (const c of cands) {
    assert.ok(["ml", "rounds", "distance", "start_round"].includes(c.grade.mma!.kind), c.grade.mma!.kind);
    assert.equal(c.agree, 1);
    assert.match(c.thesis, /records only/);
  }
  // and strict mode requires fighter stats to confirm
  const sel = selectCard({ cands, discipline: "strict" });
  assert.equal(sel.card.length, 0);
});

test("a real ESPN moneyline makes the pick book-priced and tests EV against the vig-free market", () => {
  const g = bout({
    weightClass: "Heavyweight",
    awayRecord: "22-3-0",
    homeRecord: "11-6-0",
    away: profile({ athleteId: "A1", koTkoPct: 72, strikeLPM: 5.6, decisionPct: 8 }),
    home: profile({ athleteId: "H1", strikeDefense: 42 }),
    odds: odds({ homeML: 240, awayML: -290, homeSpread: null, overUnder: null, homeSpreadOdds: null, awaySpreadOdds: null, overOdds: null, underOdds: null }),
  });
  const ml = evaluateBout(g, buildFilter(["fight_winner"]), idGen(), "loose").cands[0];
  assert.ok(ml, "moneyline evaluated");
  assert.equal(ml.priceSource, "book");
  assert.equal(ml.minOdds, null);
  assert.ok(ml.marketProb != null && ml.marketProb > 0 && ml.marketProb < 1);
  assert.ok(ml.odds === -290 || ml.odds === 240);
  assert.ok(Math.abs(ml.ev - evPerUnit(ml.modelProb, ml.odds, 0)) < 1e-12);
  assert.match(ml.thesis, /ESPN posts/);
  // the blend leans mostly on the market: our p stays within ~35% of the gap from it
  const gap = Math.abs(ml.modelProb - ml.marketProb!);
  assert.ok(gap < 0.35 * 0.5 + 1e-9, `gap ${gap}`);
});

test("PFL and DWCS bouts carry the right promotion and league", () => {
  const pfl = bout({ promotion: "pfl", sport: "pfl", weightClass: "Heavyweight", awayRecord: "22-3-0", homeRecord: "11-6-0", away: profile({ athleteId: "A1", koTkoPct: 72, strikeLPM: 5.6 }), home: profile({ athleteId: "H1", strikeDefense: 42 }) });
  const c = evaluateBout(pfl, buildFilter(["fight_winner"]), idGen(), "loose").cands;
  for (const x of c) assert.equal(x.grade.fightRef?.league, "pfl");
  const dwcs = bout({ promotion: "dwcs", sport: "dwcs" });
  assert.equal(dwcs.combat!.dist.pFinish > bout().combat!.dist.pFinish, true, "DWCS prospects finish more");
});

test("contradictory same-fight picks are never both released", () => {
  const g = lopsided();
  const { cands } = evaluateBout(g, buildFilter(["fight_distance_yes", "fight_distance_no", "method_ko", "method_sub", "method_dec", "fight_spread"]), idGen(), "loose");
  const sel = selectCard({ cands, discipline: "loose" });
  const kinds = sel.card.map((c) => `${c.grade.mma!.kind}`);
  assert.ok(sel.card.length <= 2);
  // never a KO/sub/-1.5 finish pick together with "goes the distance"
  const finish = sel.card.some((c) => {
    const m = c.grade.mma!;
    return (m.kind === "method" && m.method !== "dec") || (m.kind === "spread" && m.line === -1.5);
  });
  const distanceYes = sel.card.some((c) => c.grade.mma!.kind === "distance" && (c.grade.mma as { yes: boolean }).yes);
  assert.ok(!(finish && distanceYes), kinds.join(","));
});
