import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowsCandidate,
  buildFilter,
  MARKET_OPTIONS,
  mmaMarketKey,
  optionsForSports,
} from "../src/lib/markets";

test("every requested MMA market is selectable", () => {
  const ids = new Set(MARKET_OPTIONS.map((m) => m.id));
  const wanted = [
    "fight_winner", // moneyline
    "rounds_0_5", "rounds_1_5", "rounds_2_5", "rounds_3_5", "rounds_4_5", // total rounds o/u
    "fight_distance_yes", "fight_distance_no", // goes / doesn't go the distance
    "fight_start_2", "fight_start_3", "fight_start_4", "fight_start_5", // start round yes/no
    "fight_spread", // point spread
    "method_dec", "method_sub", "method_ko", // winning method
    "fight_sigstr", "fight_td", // volume props
  ];
  for (const id of wanted) assert.ok(ids.has(id), `missing option ${id}`);
});

test("boxing is gone everywhere", () => {
  const blob = JSON.stringify(MARKET_OPTIONS).toLowerCase();
  assert.ok(!blob.includes("boxing"));
});

test("UFC-only selection shows only combat options (no dead spread/total chips)", () => {
  const opts = optionsForSports(["ufc"]);
  assert.ok(opts.length > 0);
  assert.ok(opts.every((o) => o.group === "combat"), "all combat");
  const mixed = optionsForSports(["ufc", "nba"]);
  assert.ok(mixed.some((o) => o.id === "spread"));
  assert.ok(mixed.some((o) => o.id === "fight_winner"));
  // team-sport selection never offers MMA chips
  assert.ok(optionsForSports(["nba"]).every((o) => o.group !== "combat"));
});

test("PFL and DWCS get the same MMA options as UFC", () => {
  const ufc = optionsForSports(["ufc"]).map((o) => o.id).sort();
  assert.deepEqual(optionsForSports(["pfl"]).map((o) => o.id).sort(), ufc);
  assert.deepEqual(optionsForSports(["dwcs"]).map((o) => o.id).sort(), ufc);
});

test("mixed mode releases only real-priced markets plus MMA", () => {
  const f = buildFilter([]);
  assert.equal(f.mixed, true);
  for (const c of ["spread", "moneyline", "total", "fight_ml", "fight_rounds", "fight_sigstr", "fight_td", "fight_spread"]) {
    assert.ok(allowsCandidate(f, c), c);
  }
  // derived markets have no posted line in the free feed → opt-in only
  for (const c of ["team_total", "player_prop", "1h_total", "1h_spread", "1q_total", "p1_total", "f5_total", "nrfi"]) {
    assert.ok(!allowsCandidate(f, c), `${c} must be opt-in`);
  }
});

test("explicit selection narrows to exactly what was asked for", () => {
  const f = buildFilter(["team_total", "prop_points"]);
  assert.equal(f.mixed, false);
  assert.ok(allowsCandidate(f, "team_total"));
  assert.ok(allowsCandidate(f, "player_prop", "PTS"));
  assert.ok(!allowsCandidate(f, "player_prop", "REB"));
  assert.ok(!allowsCandidate(f, "spread"));
});

test("combat keys: pick individual lines, both directions", () => {
  const f = buildFilter(["rounds_1_5", "fight_start_3", "method_ko"]);
  assert.ok(allowsCandidate(f, "fight_rounds", undefined, "rounds_1.5"));
  assert.ok(!allowsCandidate(f, "fight_rounds", undefined, "rounds_2.5"));
  assert.ok(allowsCandidate(f, "fight_start_round", undefined, "start_3"));
  assert.ok(!allowsCandidate(f, "fight_start_round", undefined, "start_2"));
  assert.ok(allowsCandidate(f, "fight_method_win", undefined, "method_ko"));
  assert.ok(!allowsCandidate(f, "fight_method_win", undefined, "method_sub"));
  assert.ok(!allowsCandidate(f, "fight_ml", undefined, "ml"), "moneyline not selected");
});

test("mmaMarketKey lines up with the option keys", () => {
  assert.equal(mmaMarketKey({ kind: "ml", fighter: "home" }), "ml");
  assert.equal(mmaMarketKey({ kind: "rounds", dir: "over", line: 1.5 }), "rounds_1.5");
  assert.equal(mmaMarketKey({ kind: "rounds", dir: "under", line: 1.5 }), "rounds_1.5");
  assert.equal(mmaMarketKey({ kind: "distance", yes: true }), "distance_yes");
  assert.equal(mmaMarketKey({ kind: "distance", yes: false }), "distance_no");
  assert.equal(mmaMarketKey({ kind: "start_round", round: 4, yes: false }), "start_4");
  assert.equal(mmaMarketKey({ kind: "method", fighter: "away", method: "sub" }), "method_sub");
  assert.equal(mmaMarketKey({ kind: "spread", fighter: "away", line: -1.5 }), "spread");
  assert.equal(mmaMarketKey({ kind: "sigstr", fighter: "home", dir: "over", line: 40.5 }), "sigstr");
  assert.equal(mmaMarketKey({ kind: "td", fighter: "home", dir: "under", line: 0.5 }), "td");
  // every key a market can produce is covered by exactly one option
  const optionKeys = new Set(MARKET_OPTIONS.flatMap((o) => o.keys ?? []));
  for (const k of ["ml", "spread", "rounds_0.5", "rounds_4.5", "distance_yes", "distance_no", "start_2", "start_5", "method_ko", "method_sub", "method_dec", "sigstr", "td"]) {
    assert.ok(optionKeys.has(k), `no option for key ${k}`);
  }
});

test("legacy saved selections still work, and junk never blocks every pick", () => {
  // old ids expand to their granular equivalents
  const rounds = buildFilter(["fight_rounds"]);
  assert.ok(allowsCandidate(rounds, "fight_rounds", undefined, "rounds_3.5"));
  const method = buildFilter(["fight_method"]);
  assert.ok(allowsCandidate(method, "fight_distance", undefined, "distance_no"));
  // an id that no longer exists falls back to mixed instead of blocking everything
  const junk = buildFilter(["totally_removed_option"]);
  assert.equal(junk.mixed, true);
  assert.ok(allowsCandidate(junk, "spread"));
});
