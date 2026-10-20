import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFilter } from "../src/lib/markets";
import {
  evaluateTeamGame,
  marketView,
  readGame,
  spreadPush,
  totalPush,
} from "../src/lib/team-model";
import { selectCard } from "../src/lib/selection";
import { idGen, odds, team, teamGame } from "./helpers";
import type { RestInfo } from "../src/lib/espn";

const mixed = buildFilter([]);

const rest = (over: Partial<RestInfo> = {}): RestInfo => ({
  homeDays: 2,
  awayDays: 1,
  homeB2B: false,
  awayB2B: false,
  home3in4: false,
  away3in4: false,
  homeTravel: false,
  awayTravel: false,
  ...over,
});

test("a game with no situational edge produces nothing releasable (the vig is the edge-killer)", () => {
  const g = teamGame({ rest: rest() });
  const { cands } = evaluateTeamGame(g, mixed, idGen());
  assert.ok(cands.length > 0, "candidates are still evaluated so near-misses can be shown");
  for (const c of cands) assert.ok(c.ev < 0, `${c.category} EV ${c.ev} should be negative with no edge`);
  const sel = selectCard({ cands, discipline: "loose" });
  assert.equal(sel.card.length, 0, "even loose mode passes on a fair board");
});

test("the model starts from the de-vigged market, not from a win-loss record", () => {
  // Wildly different records must not move the probabilities at all.
  const a = teamGame({ home: team("BOS", { record: "40-5" }), away: team("NYK", { record: "5-40" }), rest: rest() });
  const b = teamGame({ home: team("BOS", { record: "5-40" }), away: team("NYK", { record: "40-5" }), rest: rest() });
  const ca = evaluateTeamGame(a, mixed, idGen()).cands.map((c) => [c.category, Math.round(c.modelProb * 1e6)]);
  const cb = evaluateTeamGame(b, mixed, idGen()).cands.map((c) => [c.category, Math.round(c.modelProb * 1e6)]);
  assert.deepEqual(ca, cb);
});

test("no league-average mean reversion: a low posted total is not an automatic over", () => {
  // The old engine compared the posted total to a hard-coded NBA average (224).
  for (const total of [205.5, 214.5, 224.5, 236.5]) {
    const g = teamGame({ odds: odds({ overUnder: total }), rest: rest() });
    const t = evaluateTeamGame(g, mixed, idGen()).cands.find((c) => c.category === "total")!;
    assert.ok(t, "total evaluated");
    assert.ok(Math.abs(t.modelProb - 0.5) < 0.02, `total ${total}: p=${t.modelProb}`);
    assert.ok(t.ev < 0, "no edge → negative EV after the vig");
  }
});

test("a real stack of situational edges releases a pick, sized sensibly", () => {
  const g = teamGame({
    rest: rest({ awayB2B: true, awayTravel: true, homeDays: 3 }),
    injuries: [
      { team: "NYK", player: "Star Guard", status: "Out", detail: "knee" },
      { team: "NYK", player: "Starting Big", status: "Out", detail: "ankle" },
    ],
    leaders: [
      { athlete: "Star Guard", teamAbbr: "NYK", position: "G", category: "points", stat: "PTS", seasonValue: 28, perGame: 28 },
      { athlete: "Starting Big", teamAbbr: "NYK", position: "C", category: "rebounds", stat: "REB", seasonValue: 11, perGame: 11 },
    ],
    context: {
      homeProbables: [], awayProbables: [], notes: [], lineupPosted: false, injuriesChecked: true,
      // ESPN's own projection likes Boston more than the market does
      predictor: { homeWinPct: 78, awayWinPct: 22 },
    },
    // an even-priced board so the adjustments are what matter
    odds: odds({ homeSpread: -4.5, homeML: -190, awayML: 160 }),
  });
  const intel = readGame(g);
  assert.ok(intel.usable);
  assert.ok(intel.dm > 1.5, `net margin shift ${intel.dm}`);
  const { cands } = evaluateTeamGame(g, mixed, idGen());
  const spread = cands.find((c) => c.category === "spread")!;
  assert.equal(spread.grade.side, "home");
  assert.ok(spread.modelProb > 0.55, `p=${spread.modelProb}`);
  assert.ok(spread.agree >= 2, `agree=${spread.agree}`);
  assert.deepEqual(
    ["QUANT", "MEDIC", "CHRONO"].filter((s) => spread.signals.includes(s)).sort(),
    ["CHRONO", "MEDIC", "QUANT"],
  );
  const sel = selectCard({ cands, discipline: "standard" });
  assert.ok(sel.card.length >= 1, "released");
  for (const c of sel.card) {
    assert.ok((c.finalUnits ?? 0) > 0 && (c.finalUnits ?? 0) <= 2, `units ${c.finalUnits}`);
    assert.ok(c.ev > 0.02);
    assert.equal(c.priceSource, "book");
  }
});

test("one lonely signal is not enough in standard mode", () => {
  // Only ESPN's projection disagrees with the market — nothing confirms it.
  const g = teamGame({
    rest: rest(),
    context: {
      homeProbables: [], awayProbables: [], notes: [], lineupPosted: false, injuriesChecked: true,
      predictor: { homeWinPct: 90, awayWinPct: 10 },
    },
  });
  const { cands } = evaluateTeamGame(g, mixed, idGen());
  for (const c of cands) assert.ok(c.agree <= 1);
  const sel = selectCard({ cands, discipline: "standard" });
  assert.equal(sel.card.length, 0);
});

test("unknown injury status → pass (we can't tell what the market already knows)", () => {
  const g = teamGame({
    rest: rest({ awayB2B: true }),
    context: { homeProbables: [], awayProbables: [], notes: [], lineupPosted: false, injuriesChecked: false },
  });
  const r = evaluateTeamGame(g, mixed, idGen());
  assert.equal(r.cands.length, 0);
  assert.match(r.skipped.join(" "), /injury report not fetched/);
});

test("no posted lines → pass", () => {
  const r = evaluateTeamGame(teamGame({ odds: null }), mixed, idGen());
  assert.equal(r.cands.length, 0);
  assert.match(r.skipped.join(" "), /no posted lines/);
});

test("incoherent odds data is rejected by the SHARP validation", () => {
  // Spread says HOME is a 7-point favourite; moneylines say the opposite.
  const bad = teamGame({ odds: odds({ homeSpread: -7, homeML: 220, awayML: -260 }) });
  const v = marketView(bad);
  assert.equal(v.sharpOk, false);
  assert.match(v.sharpNote, /disagree on the favourite/);
  assert.equal(evaluateTeamGame(bad, mixed, idGen()).cands.length, 0);
  // Prices that can't be a real two-way market
  const junk = teamGame({ odds: odds({ homeML: -110, awayML: -110, homeSpreadOdds: 500, awaySpreadOdds: 500 }) });
  assert.equal(marketView(junk).sharpOk, false);
});

test("heavy chalk is never laid on the moneyline", () => {
  const g = teamGame({
    odds: odds({ homeSpread: -14.5, homeML: -900, awayML: 600 }),
    rest: rest({ awayB2B: true }),
  });
  const ml = evaluateTeamGame(g, mixed, idGen()).cands.find((c) => c.category === "moneyline");
  // the underdog side is the only one eligible; the -900 side is never produced
  if (ml) assert.ok(ml.odds >= -350);
});

test("MLB moneylines need both starting pitchers posted", () => {
  const g = teamGame({
    sport: "mlb",
    odds: odds({ homeSpread: -1.5, homeSpreadOdds: 130, awaySpreadOdds: -150, homeML: -135, awayML: 115, overUnder: 8.5 }),
    rest: rest(),
  });
  const without = evaluateTeamGame(g, mixed, idGen());
  assert.ok(!without.cands.some((c) => c.category === "moneyline"));
  assert.match(without.skipped.join(" "), /starting pitchers/);
  const probable = { role: "SP", name: "A Pitcher", shortName: "A. Pitcher", position: "P", record: "5-2" };
  const withP = teamGame({
    sport: "mlb",
    odds: g.odds,
    rest: rest(),
    context: { homeProbables: [probable], awayProbables: [probable], notes: [], lineupPosted: false, injuriesChecked: true },
  });
  assert.ok(evaluateTeamGame(withP, mixed, idGen()).cands.some((c) => c.category === "moneyline"));
});

test("derived markets are opt-in and are always flagged as model-priced", () => {
  const g = teamGame({ rest: rest({ awayB2B: true }) });
  const mixedCats = new Set(evaluateTeamGame(g, mixed, idGen()).cands.map((c) => c.category));
  for (const c of ["team_total", "1h_total", "1h_spread", "1q_total", "player_prop"]) {
    assert.ok(!mixedCats.has(c as never), `${c} must not appear in mixed mode`);
  }
  const focused = buildFilter(["team_total", "first_half", "first_quarter"]);
  const cands = evaluateTeamGame(g, focused, idGen()).cands;
  assert.ok(cands.length > 0);
  for (const c of cands) {
    assert.equal(c.priceSource, "model", c.category);
    assert.ok(c.minOdds != null, "carries a price floor");
    assert.match(c.thesis, /MODEL LINE/);
    assert.match(c.thesis, /(only if your book|Never pay worse)/);
  }
  // and they are held to a higher bar than the core markets
  const sel = selectCard({ cands, discipline: "standard" });
  for (const c of sel.card) assert.ok(c.modelProb >= 0.57);
});

test("player props use the median, not the mean, and exclude the old circular line", () => {
  const g = teamGame({
    sport: "nfl",
    odds: odds({ homeSpread: -9.5, overUnder: 46.5, homeML: -400, awayML: 320 }),
    rest: rest(),
    leaders: [
      { athlete: "Big Back", teamAbbr: "BOS", position: "RB", category: "rushingYards", stat: "RUSH_YDS", seasonValue: 1200, perGame: 80 },
    ],
  });
  const cands = evaluateTeamGame(g, buildFilter(["prop_rush_yds"]), idGen()).cands.filter((c) => c.category === "player_prop");
  for (const c of cands) {
    assert.ok(c.grade.line != null && c.grade.line <= 80 * 0.9 + 0.5 + 1e-9, `line ${c.grade.line} is the median-ish number`);
    assert.match(c.thesis, /median/);
  }
});

test("push probabilities: integer lines push, half lines never do; NFL key numbers push more", () => {
  assert.equal(spreadPush(3.5, "nfl"), 0);
  assert.equal(spreadPush(3, "nfl"), 0.08);
  assert.equal(spreadPush(7, "nfl"), 0.06);
  assert.ok(spreadPush(5, "nba") > 0 && spreadPush(5, "nba") < 0.05);
  assert.equal(totalPush(220.5, "nba"), 0);
  assert.ok(totalPush(9, "mlb") > 0.05);
});

test("injuries are attributed to the right team: overlapping abbreviations never bleed across", () => {
  // "LA" must not be credited with "LAL"'s injuries just because the string contains it
  const g = teamGame({
    home: team("LA"),
    away: team("LAL"),
    injuries: [{ team: "LAL", player: "Star", status: "Out", detail: "" }],
    rest: rest(),
  });
  const intel = readGame(g);
  // only the AWAY side (LAL) is missing a player → the net effect favours the HOME side, once
  assert.ok(intel.injAdj > 0);
  const swapped = teamGame({
    home: team("LAL"),
    away: team("LA"),
    injuries: [{ team: "LAL", player: "Star", status: "Out", detail: "" }],
    rest: rest(),
  });
  assert.ok(readGame(swapped).injAdj < 0, "and it hurts LAL when LAL is at home");
  assert.ok(Math.abs(readGame(g).injAdj + readGame(swapped).injAdj) < 1e-9, "symmetric");
});
