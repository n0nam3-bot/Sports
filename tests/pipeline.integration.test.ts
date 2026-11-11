import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { asc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";

// The app's lazy `db` proxy reads this global, so everything below runs on real SQL.
(globalThis as unknown as Record<string, unknown>).__arenaNextJsPostgresqlDb = drizzle(new PGlite());

import { installFakeEspn, newState, type FakeState } from "./fake-espn";
import { db } from "../src/db";
import { agents, predictions, runs, userBets, type GradeSpec, type MmaGrade } from "../src/db/schema";
import { ensureSchema } from "../src/lib/schema";
import { cachedSlate, clearSlateCache, dedupeKeyFor, gradePending, runPipeline } from "../src/lib/engine";
import { listBets, upsertBet, setBetResult, deleteBet, betsToCsv } from "../src/lib/bets";
import { listAgents } from "../src/lib/agents";
import { parseMmaMoneylines } from "../src/lib/fighter-stats";
import { buildFilter } from "../src/lib/markets";
import { evaluateTeamGame } from "../src/lib/team-model";

const OWNER = "wtestowner0001";
const OTHER = "wsomebodyelse01";
const D = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
let state: FakeState;
let restore: () => void;

before(async () => {
  state = newState(D);
  restore = installFakeEspn(state);
  await ensureSchema();
});
after(() => restore());

async function newRun(sports: string[], markets: string[] = [], discipline = "standard") {
  const [r] = await db.insert(runs).values({ ownerId: OWNER, slateDate: D, sports, markets, discipline, status: "running" }).returning();
  return r.id;
}
const runRow = async (id: number) => (await db.select().from(runs).where(eq(runs.id, id)))[0];
const allPreds = () => db.select().from(predictions).orderBy(asc(predictions.id));

// ---------------------------------------------------------------------------
test("slate: DWCS and UFC are separated, and real ESPN fighter stats flow into the joint model", async () => {
  const ufc = await cachedSlate(D, ["ufc"]);
  assert.equal(ufc.games.length, 2, "the Contender Series card is not part of UFC");
  assert.ok(ufc.games.every((g) => g.combat?.promotion === "ufc"));
  assert.deepEqual(ufc.degraded, []);
  for (const g of ufc.games) {
    assert.equal(g.combat!.dist.statsUsed, true, `${g.matchup} has career stats`);
    assert.match(g.combat!.fighterIds.away ?? "", /^\d+$/, "numeric ESPN athlete id");
    assert.ok((g.combat!.model.summary ?? "").length > 10);
  }
  const dwcs = await cachedSlate(D, ["dwcs"]);
  assert.equal(dwcs.games.length, 1);
  assert.equal(dwcs.games[0].combat!.promotion, "dwcs");
  assert.equal(dwcs.games[0].combat!.league, "ufc", "DWCS fighters live in ESPN's ufc league");
  const pfl = await cachedSlate(D, ["pfl"]);
  assert.equal(pfl.games.length, 0);
});

test("the lopsided bout is priced by the joint model; the symmetric bout is a coin flip", async () => {
  const { games } = await cachedSlate(D, ["ufc"]);
  const b1 = games.find((g) => g.combat!.competitionId === "B1")!.combat!;
  const b2 = games.find((g) => g.combat!.competitionId === "B2")!.combat!;
  assert.ok(b1.dist.pAway > 0.62, `away favourite ${b1.dist.pAway}`);
  assert.ok(b1.dist.pFinish > 0.55);
  assert.equal(b1.dist.rounds, 5);
  assert.ok(Math.abs(b2.dist.pHome - 0.5) < 0.02, `even bout ${b2.dist.pHome}`);
});

test("a real ESPN moneyline is matched to fighters by ATHLETE ID (never by position)", async () => {
  state.mmaMoneyline = true;
  const { games } = await cachedSlate(D, ["ufc", "pfl"]); // distinct cache key
  state.mmaMoneyline = false;
  const g = games.find((x) => x.combat!.competitionId === "B1")!;
  assert.equal(g.odds?.awayML, -290);
  assert.equal(g.odds?.homeML, 240);
  assert.equal(g.combat!.priceSource, "espn");

  // The payload lists the HOME fighter first. Position-based mapping would swap the prices.
  const payload = {
    items: [{
      homeAthleteOdds: { athlete: { $ref: "https://x/athletes/222" }, moneyLine: 240 },
      awayAthleteOdds: { athlete: { $ref: "https://x/athletes/111" }, moneyLine: -290 },
    }],
  };
  assert.deepEqual(parseMmaMoneylines(payload, "111", "222"), { away: -290, home: 240 });
  assert.deepEqual(parseMmaMoneylines(payload, "222", "111"), { away: 240, home: -290 }, "swapping the ids swaps the prices");
  // unidentifiable fighters → refuse rather than guess
  assert.equal(parseMmaMoneylines(payload, "111", "999"), null);
  assert.equal(parseMmaMoneylines(payload, null, "222"), null);
  assert.equal(parseMmaMoneylines({ items: [{ homeAthleteOdds: { moneyLine: 240 }, awayAthleteOdds: { moneyLine: -290 } }] }, "111", "222"), null);
  // two prices that can't be one market
  assert.equal(parseMmaMoneylines({ items: [{ homeAthleteOdds: { athlete: { $ref: "x/athletes/222" }, moneyLine: 500 }, awayAthleteOdds: { athlete: { $ref: "x/athletes/111" }, moneyLine: 500 } }] }, "111", "222"), null);
});

// ---------------------------------------------------------------------------
let run1: number;

test("pipeline (mixed markets, standard discipline): releases only what clears the bar", async () => {
  run1 = await newRun(["nba", "ufc", "dwcs"]);
  await runPipeline(run1, {}, OWNER, false);
  const r = await runRow(run1);
  assert.equal(r.status, "completed");
  assert.equal(r.gamesFound, 6, "3 NBA + 2 UFC + 1 DWCS");
  assert.equal(r.mode, "heuristic");
  assert.equal(r.council?.discipline, "standard");
  assert.equal(r.council?.noPlay, false);

  const ps = await allPreds();
  const byGame = (m: string) => ps.filter((p) => p.matchup.includes(m));
  // E1: the stacked-edge NBA game → exactly one side bet, on BOS
  const bos = byGame("BOS");
  assert.equal(bos.length, 1, "one side bet per game");
  assert.equal(bos[0].category, "spread");
  assert.equal(bos[0].pick, "Boston Celtics -4.5");
  assert.equal(bos[0].priceSource, "book");
  assert.equal(bos[0].engineVersion, 5);
  assert.equal(bos[0].odds, -110);
  assert.ok(bos[0].units > 0 && bos[0].units <= 2);
  assert.ok(bos[0].modelProb! > 0.55 && bos[0].modelProb! < 0.7);
  assert.equal(bos[0].marketProb, 0.5);
  assert.equal(bos[0].confidence, Math.round(bos[0].modelProb! * 1000) / 10, "confidence is now the win probability");
  assert.ok(bos[0].edge > 0, "edge is EV% and must be positive for a released book pick");
  for (const code of ["QUANT", "MEDIC", "CHRONO", "NBA_EXPERT", "COMMISSIONER", "STRATEGA"]) {
    assert.ok(bos[0].agents.includes(code), `${code} backed it`);
  }
  assert.ok(!bos[0].agents.includes("PROPS"));
  // E2 (fair board) and E3 (injury report never fetched) produce nothing
  assert.equal(byGame("LAL").length, 0);
  assert.equal(byGame("MIA").length, 0);
  // MMA: model-priced, with a price floor, and only for the lopsided bout
  const mma = ps.filter((p) => p.category.startsWith("fight_"));
  assert.ok(mma.length >= 1);
  for (const p of mma) {
    assert.equal(p.priceSource, "model");
    assert.ok(p.minPrice != null && p.odds === p.minPrice, "ledger/sizing price is the conservative floor");
    assert.ok(p.units > 0 && p.units <= 1, `model-priced stake ${p.units}`);
    assert.ok((p.modelProb ?? 0) <= 0.75 + 1e-9);
    assert.equal((p.grade as { segment?: string }).segment, "FIGHT");
    assert.ok((p.grade as { mma?: unknown }).mma, "structured market stored");
    assert.deepEqual((p.grade as { fightRef: { league: string; cardId: string } }).fightRef.cardId, "CARD1");
    assert.match(p.reasoning, /MODEL PRICE/);
    assert.ok(p.matchup.includes("FIGHTER"), "fixture bout");
  }
  assert.equal(ps.filter((p) => p.matchup.includes("ALPHA")).length, 0, "symmetric bout: nothing to say");
  // never more than 2 picks on one bout, one per cluster
  assert.ok(mma.length <= 2);
  // the memo and trace tell the story
  const memo = r.council!.memo;
  assert.match(memo, /cleared the bar/);
  assert.ok(r.council!.exposure! > 0 && r.council!.exposure! <= 8);
  assert.ok(r.council!.avoided.some((a) => /injury report not fetched/.test(a)));
  const agentsInTrace = new Set(r.trace.map((t) => t.agent));
  for (const a of ["QUANT", "MEDIC", "CHRONO", "SHARP", "MMA_EXPERT", "HISTORIAN", "RISK", "COMMISSIONER"]) {
    assert.ok(agentsInTrace.has(a), `trace has ${a}`);
  }
});

test("re-running the same slate never duplicates a wager, and adds nothing the first run didn't have", async () => {
  const before = await allPreds();
  const run2 = await newRun(["nba", "ufc", "dwcs"]);
  await runPipeline(run2, {}, OWNER, false);
  const after = await allPreds();
  // Before the per-game limits carried over between runs, this inserted a 4th pick (a third bet on the
  // same fight) even though nothing about the slate had changed.
  assert.equal(after.length, before.length, "no clones, and nothing new");
  const r = await runRow(run2);
  assert.equal(r.status, "completed");
  assert.equal(r.carried.length, before.length, "every pick the council still endorses is acknowledged as standing");
  assert.equal(r.council!.repeats!.length, before.length);
  assert.match(r.council!.headline, /NOTHING NEW/);
  assert.match(r.council!.memo, /still stand/);
  assert.equal(r.council!.funnel!.repeats, before.length);
  assert.equal(r.council!.noPlay, false, "the day's card exists; this run just added nothing to it");
  assert.equal(r.council!.exposure, 0, "a run that adds nothing risks nothing");
});

test("duplicates do not use up a re-run's slots: a genuinely new pick still gets in", async () => {
  await db.delete(userBets);
  await db.delete(predictions);
  clearSlateCache();
  // strict allows only 3 picks: the first run's three fill the card completely
  const r1 = await newRun(["nba", "ufc", "dwcs"], [], "strict");
  await runPipeline(r1, {}, OWNER, false);
  const first = await allPreds();
  assert.equal(first.length, 3, `strict's card is full: ${first.map((p) => p.pick).join(" | ")}`);

  // later, a moderate confirmed edge appears on a game that was not in the first run
  state.extraEdgeGame = true;
  clearSlateCache();
  const r2 = await newRun(["nba", "ufc", "dwcs"], [], "strict");
  await runPipeline(r2, {}, OWNER, false);
  const second = await allPreds();
  const added = second.filter((p) => p.runId === r2);
  // The old engine selected over the full pool, so the three existing bets (which rank higher)
  // filled the card and this one was rejected as "card is full" — then the three were discarded
  // as duplicates. Slots spent, nothing gained.
  assert.equal(added.length, 1, `exactly one new pick: ${added.map((p) => p.pick).join(" | ")}`);
  assert.match(added[0].matchup, /DAL/);
  assert.ok(added[0].units > 0);
  const row2 = await runRow(r2);
  assert.equal(row2.carried.length, 3, "the three earlier picks still stand");
  assert.equal(row2.council!.funnel!.plays, 1);
  assert.equal(row2.council!.funnel!.repeats, 3);
  assert.equal(row2.council!.exposure, added[0].units, "this run risks only what it added");
  assert.match(row2.council!.memo, /3 earlier picks from this slate still stand/);
  // …and the existing games gained nothing: per-game limits carry over between runs
  assert.equal(second.filter((p) => p.matchup.includes("BOS")).length, 1);
  assert.equal(second.filter((p) => p.matchup.includes("FIGHTER")).length, 2);

  // a third run with the same information adds nothing at all
  clearSlateCache();
  const r3 = await newRun(["nba", "ufc", "dwcs"], [], "strict");
  await runPipeline(r3, {}, OWNER, false);
  state.extraEdgeGame = false;
  assert.equal((await allPreds()).length, 4);
  assert.match((await runRow(r3)).council!.headline, /NOTHING NEW/);
});

test("runs that add nothing new go to the Log, not the Ledger — and can never push real runs out of its window", async () => {
  const { GET } = await import("../src/app/api/runs/route");
  const list = async () => ((await (await GET(new NextRequest("http://x/api/runs"))).json()) as { runs: { id: number; productive: boolean; slateDate: string; predictions: unknown[] }[] }).runs;

  const before = await list();
  const productiveIds = before.filter((r) => r.productive).map((r) => r.id);
  const idleIds = before.filter((r) => !r.productive).map((r) => r.id);
  assert.ok(productiveIds.length >= 2, "runs that released a new pick are productive");
  assert.ok(idleIds.length >= 2, "…and the ones that only repeated earlier picks are not");
  // a run that only re-selected earlier picks still shows them (the War Room needs the day's card)…
  const repeatRun = before.find((r) => !r.productive && r.predictions.length > 0);
  assert.ok(repeatRun, "a repeat-only run still carries the picks that stand, for display");
  // …but it released nothing of its own
  const fresh = await db.select().from(predictions).where(eq(predictions.runId, repeatRun!.id));
  assert.equal(fresh.length, 0);

  // Pile on far more empty runs than either window holds. Under a single combined 50-run window these
  // newer runs would push every productive run out of the Ledger.
  await db.insert(runs).values(
    Array.from({ length: 130 }, () => ({ ownerId: OWNER, slateDate: "2000-01-01", sports: ["nba"], status: "completed", discipline: "standard" })),
  );
  const after = await list();
  assert.deepEqual(
    after.filter((r) => r.productive).map((r) => r.id).sort((a, b) => a - b),
    productiveIds.sort((a, b) => a - b),
    "every productive run is still in the Ledger's window",
  );
  const idle = after.filter((r) => !r.productive);
  assert.equal(idle.length, 100, "the Log keeps its own, separate window");
  assert.ok(idle.every((r, i, a) => i === 0 || a[i - 1].id > r.id), "newest first");
  await db.delete(runs).where(eq(runs.slateDate, "2000-01-01"));
});

test("focused MMA selections return exactly the markets asked for, with structured grades", async () => {
  const families: [string[], (m: MmaGrade) => boolean][] = [
    [["rounds_0_5", "rounds_1_5", "rounds_2_5", "rounds_3_5", "rounds_4_5"], (m) => m.kind === "rounds"],
    [["fight_start_2", "fight_start_3", "fight_start_4", "fight_start_5"], (m) => m.kind === "start_round"],
    [["fight_distance_yes", "fight_distance_no"], (m) => m.kind === "distance"],
    [["method_dec", "method_sub", "method_ko"], (m) => m.kind === "method"],
    [["fight_spread"], (m) => m.kind === "spread"],
    [["fight_sigstr"], (m) => m.kind === "sigstr"],
    [["fight_td"], (m) => m.kind === "td"],
  ];
  const seen = new Set<string>();
  for (const [markets, ok] of families) {
    // Each family is judged on a clean ledger: the engine (correctly) won't stack a second bet on an
    // angle of a fight that already has one, so families that share an angle would otherwise block each other.
    await db.delete(userBets);
    await db.delete(predictions);
    const id = await newRun(["ufc"], markets, "loose");
    await runPipeline(id, {}, OWNER, false);
    const r = await runRow(id);
    assert.equal(r.status, "completed", markets.join(","));
    const ps = (await allPreds()).filter((p) => p.runId === id);
    for (const p of ps) {
      const m = (p.grade as { mma: MmaGrade }).mma;
      assert.ok(ok(m), `${markets.join(",")} produced a ${m.kind}`);
      seen.add(m.kind);
    }
  }
  assert.ok(seen.size >= 4, `the lopsided bout yielded picks across several families: ${[...seen]}`);
});

test("a pass day is a first-class result: the run is KEPT (the old engine deleted it and hung the client)", async () => {
  for (const id of ["401001", "401002", "401003"]) state.failSummary.add(id);
  const id = await newRun(["nba"], ["spread"]);
  await runPipeline(id, {}, OWNER, false);
  for (const e of ["401001", "401002"]) state.failSummary.delete(e);
  const r = await runRow(id);
  assert.ok(r, "run row still exists");
  assert.equal(r.status, "completed");
  assert.equal(r.council?.noPlay, true);
  assert.match(r.council!.headline, /PASS/);
  assert.match(r.council!.memo, /profitable decision is to pass/i);
  assert.equal((await allPreds()).filter((p) => p.runId === id).length, 0);

  // and the client's poll endpoint can still read it (it used to 404)
  const { GET } = await import("../src/app/api/runs/[id]/route");
  const res = await GET(new Request(`http://x/api/runs/${id}`), { params: Promise.resolve({ id: String(id) }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { run: { status: string; predictions: unknown[] } };
  assert.equal(body.run.status, "completed");
  assert.deepEqual(body.run.predictions, []);
});

// ---------------------------------------------------------------------------
test("LLM review is bounded: it can trim a little, veto a few, and a hostile model cannot wipe out the card", async () => {
  const keys = { openrouter: "test-key" };
  const ids = (user: string, re: RegExp): number[] =>
    [...user.matchAll(/#(\d+) ([^\n]*)/g)].filter((m) => re.test(m[2])).map((m) => Number(m[1]));

  // the deterministic probabilities of the Boston candidates, before any review
  const { games } = await cachedSlate(D, ["nba", "ufc"]);
  const bosGame = games.find((g) => g.matchup.includes("BOS"))!;
  const baseline = new Map(evaluateTeamGame(bosGame, buildFilter([]), () => 1).cands.map((c) => [c.category, c.modelProb]));

  state.llm = ({ system, user }) => {
    if (/NBA_EXPERT/.test(system)) {
      // absurd −50 points of probability on every Boston candidate: must be clamped to −5
      return JSON.stringify({
        reviews: ids(user, /Celtics/).map((id) => ({ id, verdict: "trim", deltaProb: -0.5, reason: "Home wing is questionable per the supplied report" })),
        notes: "one concern",
      });
    }
    if (/CONTRARIAN/.test(system)) {
      // hostile: veto EVERYTHING that is not Boston
      const boston = new Set(ids(user, /Celtics/));
      const all = [...user.matchAll(/#(\d+) /g)].map((m) => Number(m[1])).filter((id) => !boston.has(id));
      return JSON.stringify({ reviews: all.map((id) => ({ id, verdict: "veto", deltaProb: 0, reason: "Everything looks risky to me today" })), notes: "vetoing all" });
    }
    return "this is not JSON at all"; // STRATEGA misbehaves too
  };
  // wipe the dedupe state so the run builds a fresh card
  await db.delete(userBets);
  await db.delete(predictions);
  const id = await newRun(["nba", "ufc"]);
  await runPipeline(id, keys, OWNER, true);
  const r = await runRow(id);
  assert.equal(r.status, "completed");
  assert.equal(r.mode, "llm");
  assert.ok(state.llmCalls.length >= 3, `reviewers were consulted (${state.llmCalls.length} calls)`);
  const summary = r.trace.find((t) => t.agent === "STRATEGA" && /within hard bounds/.test(t.message));
  assert.ok(summary, "review summary in the trace");
  const vetoes = Number(summary!.message.match(/(\d+) veto/)?.[1] ?? "99");
  const trims = Number(summary!.message.match(/(\d+) probability trim/)?.[1] ?? "0");
  assert.ok(vetoes >= 1, "the hostile reviewer did veto something");
  assert.ok(vetoes <= Math.floor(14 * 0.4), `vetoes ${vetoes} exceed the 40% cap on a 14-candidate shortlist`);
  assert.ok(trims >= 1);

  // The card survives: Boston is still released, with a probability trimmed by AT MOST 5 points,
  // not by the −50 the model asked for.
  const bos = (await allPreds()).find((p) => p.pick.includes("Celtics"));
  assert.ok(bos, "a hostile model must not wipe out the card");
  const base = baseline.get(bos!.category as "spread" | "moneyline")!;
  assert.ok(Math.abs(bos!.modelProb! - (base - 0.05)) < 1e-6, `p=${bos!.modelProb} base=${base}`);
  assert.match(bos!.reasoning, /NBA_EXPERT/);
  assert.match(bos!.reasoning, /-5\.0pt/);
  state.llm = undefined;
});

test("a broken or unreachable LLM changes nothing: the deterministic card stands", async () => {
  const keys = { openrouter: "test-key" };
  for (const behaviour of [() => null, () => "garbage <<<", () => '{"reviews":"nope"}']) {
    state.llm = behaviour;
    await db.delete(predictions);
    const id = await newRun(["nba", "ufc"]);
    await runPipeline(id, keys, OWNER, true);
    const r = await runRow(id);
    assert.equal(r.status, "completed");
    const bos = (await allPreds()).find((p) => p.pick.includes("Celtics"));
    assert.ok(bos, "the BOS pick is still released");
    assert.ok(Math.abs(bos!.modelProb! - 0.589) < 0.01, `untouched probability ${bos!.modelProb}`);
  }
  state.llm = undefined;
});

// ---------------------------------------------------------------------------
test("leans: a sub-bar edge is published with NO stake, and never touches ratings, track record or the follow-everything baseline", async () => {
  state.leanGame = true;
  await db.delete(userBets);
  await db.delete(predictions);
  const id = await newRun(["nba", "pfl"]); // a sports key no earlier test used (the slate cache is keyed by it)
  await runPipeline(id, {}, OWNER, false);
  const r = await runRow(id);
  assert.equal(r.status, "completed");

  const ps = await allPreds();
  const plays = ps.filter((p) => p.units > 0);
  const leans = ps.filter((p) => p.units === 0);
  assert.deepEqual(plays.map((p) => p.pick), ["Boston Celtics -4.5"], "the stacked edge is still a play");
  assert.equal(leans.length, 1);
  const lean = leans[0];
  assert.equal(lean.pick, "Sacramento Kings ML");
  assert.equal(lean.priceSource, "book");
  assert.equal(lean.units, 0, "a lean carries no stake");
  assert.match(lean.reasoning, /^LEAN — below the bar/);
  assert.ok(lean.edge > 0.4 && lean.edge < 2.2, `EV ${lean.edge}% sits between the lean floor and the play bar`);
  assert.ok(lean.modelProb! > 0.55 && lean.modelProb! < 0.65);
  for (const council of ["COMMISSIONER", "RISK", "STRATEGA", "HISTORIAN", "CONTRARIAN"]) {
    assert.ok(!lean.agents.includes(council), `${council} did not approve a lean`);
  }

  // the council tells the story, including where the slate went
  assert.equal(r.council!.leans, 1);
  assert.equal(r.council!.noPlay, false);
  assert.match(r.council!.memo, /1 lean is below the bar/);
  const f = r.council!.funnel!;
  assert.equal(f.games, 4);
  assert.equal(f.priced, 3, "the unchecked-injury game could not be priced");
  assert.deepEqual(f.gaps.map((g) => g.n), [1]);
  assert.match(f.gaps[0].reason, /injury report not fetched/);
  assert.equal(f.plays, 1);
  assert.equal(f.leans, 1);
  assert.ok(f.bestEv! > f.bar, "the best candidate on the board cleared the bar (the BOS play)");
  assert.equal(f.bar, 0.022);
  assert.equal(r.council!.exposure, plays[0].units, "leans add no risk");
  assert.ok(!r.council!.avoided.some((a) => /Kings/.test(a)), "a lean is not repeated as a near-miss");

  // ---- grading: the lean is graded, but is invisible to every statistic that is about staked plays ----
  const quant = async () => (await listAgents("house")).find((a) => a.codename === "QUANT")!;
  const before = await quant();
  await db.update(predictions).set({ startTime: new Date(Date.now() - 3 * 3600_000) });
  state.phase = "final";
  const res = await gradePending();
  state.phase = "pre";
  assert.equal(res.graded, 2);
  const graded = await allPreds();
  assert.equal(graded.find((p) => p.units === 0)!.outcome, "win", "SAC 108-104 → the lean won");
  assert.equal(graded.find((p) => p.units > 0)!.outcome, "win");
  const after = await quant();
  assert.equal(after.wins - before.wins, 1, "only the staked BOS play credited QUANT; the lean did not");

  const { loadHealth } = await import("../src/lib/health");
  const health = await loadHealth();
  const nbaMl = health.buckets.get("nba:moneyline");
  assert.ok(!nbaMl || nbaMl.n === 0, "a lean is not part of the track record");
  assert.equal(health.overall.n, 1, "the track record counts the staked play only");

  // the tracker's follow-everything baseline ignores leans too (there is no stake to follow)
  const bos = graded.find((p) => p.units > 0)!;
  await upsertBet(OWNER, { predictionId: bos.id, stake: 1, odds: -110 });
  await upsertBet(OWNER, { predictionId: lean.id, stake: 0.25, odds: -140 }); // a person may still bet a lean
  const { summary } = await listBets(OWNER);
  assert.equal(summary.total, 2);
  assert.equal(summary.followAllBets, 1, "baseline = staked plays only");
  assert.equal(summary.wins, 2, "…but the person's own bet on a lean counts in THEIR record");
  state.leanGame = false; // (kept on until here: the fake's final scoreboard needs the game too)
});

test("grading: every released pick settles correctly against the final scores", async () => {
  // The pipeline won't stack several bets on one angle of one fight, so to exercise the grader on EVERY market
  // kind, file one pick per market directly — exactly as earlier runs would have.
  await db.delete(userBets);
  await db.delete(predictions);
  clearSlateCache();
  await runPipeline(await newRun(["nba", "ufc", "dwcs"]), {}, OWNER, false);
  const fightRef = { league: "ufc" as const, cardId: "CARD1", homeId: "4001002", awayId: "4001001" };
  const both = ["home", "away"] as const;
  const dirs = ["over", "under"] as const;
  const markets: MmaGrade[] = [
    ...both.map((fighter) => ({ kind: "ml", fighter }) as MmaGrade),
    ...[0.5, 1.5, 2.5, 3.5, 4.5].flatMap((line) => dirs.map((dir) => ({ kind: "rounds", dir, line }) as MmaGrade)),
    { kind: "distance", yes: true },
    { kind: "distance", yes: false },
    ...[2, 3, 4, 5].flatMap((round) => [true, false].map((yes) => ({ kind: "start_round", round, yes }) as MmaGrade)),
    ...both.flatMap((fighter) => [-1.5, 1.5].map((line) => ({ kind: "spread", fighter, line }) as MmaGrade)),
    ...both.flatMap((fighter) => (["ko", "sub", "dec"] as const).map((method) => ({ kind: "method", fighter, method }) as MmaGrade)),
    ...both.flatMap((fighter) => [30.5, 55.5, 70.5].flatMap((line) => dirs.map((dir) => ({ kind: "sigstr", fighter, dir, line }) as MmaGrade))),
    ...both.flatMap((fighter) => [0.5, 1.5].flatMap((line) => dirs.map((dir) => ({ kind: "td", fighter, dir, line }) as MmaGrade))),
  ];
  const categoryOf = { ml: "fight_ml", rounds: "fight_rounds", distance: "fight_distance", start_round: "fight_start_round", spread: "fight_spread", method: "fight_method_win", sigstr: "fight_sigstr", td: "fight_td" } as const;
  const legacy = (m: MmaGrade): Pick<GradeSpec, "side" | "line"> => {
    switch (m.kind) {
      case "ml": case "method": return { side: m.fighter, line: null };
      case "spread": return { side: m.fighter, line: m.line };
      case "rounds": case "sigstr": case "td": return { side: m.dir, line: m.line };
      case "distance": return { side: m.yes ? "over" : "under", line: null };
      case "start_round": return { side: m.yes ? "over" : "under", line: m.round };
    }
  };
  for (const [i, mma] of markets.entries()) {
    const grade: GradeSpec = { ...legacy(mma), segment: "FIGHT", mma, fightRef };
    const category = categoryOf[mma.kind];
    await db.insert(predictions).values({
      ownerId: OWNER, runId: run1, sortOrder: 100 + i, slateDate: D, sport: "ufc", eventId: "B1",
      dedupeKey: dedupeKeyFor(D, { game: { sport: "ufc", eventId: "B1" }, category, grade }),
      matchup: "FIGHTER vs FIGHTER", category, pick: `filed ${mma.kind} ${JSON.stringify(mma)}`, lineLabel: "x",
      odds: -110, units: 0.5, confidence: 60, edge: 3, modelProb: 0.6, priceSource: "model", minPrice: -110, engineVersion: 5,
      agents: ["MMA_EXPERT"], grade,
    }).onConflictDoNothing(); // (the pipeline's own pick on the same wager, if any, is graded by the same oracle)
  }
  const pending = await allPreds();
  assert.ok(pending.every((p) => p.outcome === "pending"));
  assert.ok(pending.length >= 5);

  // not gradable until 45 minutes after the start
  assert.equal((await gradePending()).graded, 0);

  await db.update(predictions).set({ startTime: new Date(Date.now() - 3 * 3600_000) });
  state.phase = "final";
  const summary = await gradePending();
  assert.equal(summary.graded + summary.voided, pending.length, JSON.stringify(summary));
  assert.equal(summary.voided, 0);

  // ---- independent oracle ----
  // B1: AWAY wins by KO/TKO, round 2 at 3:15 → 8.25 minutes. Sig strikes away 61 / home 22; takedowns 0 / 1.
  const elapsed = 8.25;
  const win = (b: boolean) => (b ? "win" : "loss");
  const oracle = (m: MmaGrade): string => {
    switch (m.kind) {
      case "ml": return win(m.fighter === "away");
      case "rounds": return win((elapsed > m.line * 5) === (m.dir === "over"));
      case "distance": return win(!m.yes); // it was a finish
      case "start_round": return win((Math.ceil(elapsed / 5) >= m.round) === m.yes);
      case "spread": return m.line === -1.5 ? win(m.fighter === "away") : win(m.fighter === "away"); // away wins by finish: away +1.5 covers, home +1.5 loses
      case "method": return win(m.fighter === "away" && m.method === "ko");
      case "sigstr": return win(((m.fighter === "away" ? 61 : 22) > m.line) === (m.dir === "over"));
      case "td": return win(((m.fighter === "away" ? 0 : 1) > m.line) === (m.dir === "over"));
    }
  };
  const graded = await allPreds();
  let mmaChecked = 0;
  const kinds = new Set<string>();
  for (const p of graded) {
    if (p.category.startsWith("fight_")) {
      const g = p.grade as { mma: MmaGrade };
      if (p.matchup.includes("FIGHTER")) {
        assert.equal(p.outcome, oracle(g.mma), `${p.pick} → ${p.outcome}`);
        assert.match(p.finalScore ?? "", /KO\/TKO R2 3:15/);
        mmaChecked++;
        kinds.add(g.mma.kind);
      }
    }
  }
  assert.ok(mmaChecked >= 5, `checked ${mmaChecked} MMA picks`);
  assert.ok(kinds.size >= 4, `grading covered ${[...kinds].join(",")}`);
  const sig = graded.find((p) => (p.grade as { mma?: MmaGrade }).mma?.kind === "sigstr");
  if (sig) assert.match(sig.finalScore!, /sig\. strikes 61-22/);

  // NBA: BOS 112, NYK 101 → BOS -4.5 wins
  const bos = graded.find((p) => p.pick === "Boston Celtics -4.5")!;
  assert.equal(bos.outcome, "win");
  assert.equal(bos.finalScore, "NYK 101 — BOS 112");
  assert.ok(bos.gradedAt);

  // agents are paid only for what they backed
  const roster = await listAgents("house");
  const code = (c: string) => roster.find((a) => a.codename === c)!;
  assert.ok(code("QUANT").wins >= 1, "QUANT backed the winning BOS pick");
  assert.notEqual(code("QUANT").rating, 1500);
  assert.equal(code("PROPS").wins + code("PROPS").losses, 0, "PROPS backed nothing, so it has no record");
  assert.equal(code("NHL_EXPERT").wins + code("NHL_EXPERT").losses, 0);
  assert.equal(code("MMA_EXPERT").wins + code("MMA_EXPERT").losses >= 1, true);
  // not every council agent shares the card record any more
  const records = ["QUANT", "MEDIC", "STRATEGA", "CONTRARIAN", "COMMISSIONER", "RISK", "HISTORIAN"].map((c) => `${code(c).wins}-${code(c).losses}`);
  assert.ok(new Set(records).size > 1, `agents have distinct records: ${records}`);

  // grading is idempotent
  assert.deepEqual(await gradePending(), { graded: 0, wins: 0, losses: 0, pushes: 0, voided: 0 });
});

test("stale pending bets are voided instead of hanging forever; unreadable stats are voided after a grace period", async () => {
  state.phase = "pre"; // the feed never reports these as final
  const [p] = await db
    .insert(predictions)
    .values({ ownerId: OWNER, dedupeKey: "stale-1", runId: run1, sortOrder: 99, slateDate: D, sport: "nba", eventId: "NOPE", matchup: "X @ Y", category: "spread", pick: "Y -1.5", lineLabel: "x", odds: -110, units: 1, confidence: 55, edge: 2, grade: { side: "home", line: -1.5 }, startTime: new Date(Date.now() - 6 * 86_400_000) })
    .returning();
  const res = await gradePending();
  assert.equal(res.voided, 1);
  const [row] = await db.select().from(predictions).where(eq(predictions.id, p.id));
  assert.equal(row.outcome, "void");
  assert.match(row.finalScore ?? "", /voided/);
  // fresh ones are left alone
  await db.insert(predictions).values({ ownerId: OWNER, dedupeKey: "fresh-1", runId: run1, sortOrder: 98, slateDate: D, sport: "nba", eventId: "NOPE2", matchup: "X @ Y", category: "spread", pick: "Y -1.5", lineLabel: "x", odds: -110, units: 1, confidence: 55, edge: 2, grade: { side: "home", line: -1.5 }, startTime: new Date(Date.now() - 2 * 3600_000) });
  assert.equal((await gradePending()).voided, 0);
  state.phase = "final";
});

// ---------------------------------------------------------------------------
test("tracker: bets are personal, priced at what the person got, and settle from the graded result", async () => {
  const preds = await allPreds();
  const bos = preds.find((p) => p.pick === "Boston Celtics -4.5")!;
  const mmaWin = preds.find((p) => p.category.startsWith("fight_") && p.outcome === "win" && p.matchup.includes("FIGHTER"));
  assert.ok(mmaWin, "the fixture's favourite won, so its MMA picks are winners");
  // …so manufacture a losing MMA pick (the model backed the winner every time)
  const [mmaLoss] = await db
    .insert(predictions)
    .values({ ownerId: OWNER, dedupeKey: "synthetic-loss", runId: run1, sortOrder: 60, slateDate: D, sport: "ufc", eventId: "B1", matchup: "FIGHTER vs FIGHTER", category: "fight_ml", pick: "Home Fighter ML", lineLabel: "ML", odds: 180, units: 0.5, confidence: 40, edge: 3, modelProb: 0.4, priceSource: "model", minPrice: 180, engineVersion: 5, outcome: "loss", grade: { side: "home", line: null, mma: { kind: "ml", fighter: "home" } }, startTime: new Date(Date.now() - 3 * 3600_000) })
    .returning();

  // the person only takes 3 of the picks, at their OWN stake and price
  const a = await upsertBet(OWNER, { predictionId: bos.id, stake: 1.5, odds: -105, note: "got -105 at the other book" });
  assert.ok(a.ok);
  if (!a.ok) return;
  assert.equal(a.bet.result, "win");
  assert.equal(a.bet.pnl, 1.429, "1.5u at -105 wins 1.4286u");
  assert.equal(a.bet.late, true, "logged after the game started → flagged");
  assert.ok(a.bet.evAtPrice != null && a.bet.evAtPrice > 0.05, "EV at the person's price vs our probability");

  const b = await upsertBet(OWNER, { predictionId: mmaLoss.id, stake: 0.5, odds: 130 });
  const c = await upsertBet(OWNER, { predictionId: mmaWin.id, stake: 1, odds: -140 });
  assert.ok(b.ok && c.ok);
  if (!b.ok || !c.ok) return;
  assert.equal(b.bet.pnl, -0.5);
  assert.equal(c.bet.pnl, 0.714);

  // editing the stake/price keeps the original logged time
  const a2 = await upsertBet(OWNER, { predictionId: bos.id, stake: 2, odds: -110 });
  assert.ok(a2.ok);
  if (!a2.ok) return;
  assert.equal(a2.bet.placedAt, a.bet.placedAt);
  assert.equal(a2.bet.pnl, 1.818);

  // someone else's tracker is a separate world
  assert.deepEqual((await listBets(OTHER)).bets, []);
  await upsertBet(OTHER, { predictionId: bos.id, stake: 5, odds: -110 });
  assert.equal((await listBets(OWNER)).bets.length, 3);

  const { bets, summary } = await listBets(OWNER);
  assert.equal(summary.total, 3);
  assert.equal(summary.wins, 2);
  assert.equal(summary.losses, 1);
  assert.equal(summary.pending, 0);
  assert.equal(summary.staked, 3.5);
  assert.equal(summary.pnl, 2.03, "1.818 − 0.5 + 0.714");
  assert.equal(summary.roi, Math.round((2.03 / 3.5) * 10000) / 10000);
  assert.equal(summary.winRate, Math.round((2 / 3) * 10000) / 10000);
  assert.ok(summary.followAllBets >= 3, "the baseline covers every pick on the days you bet");
  assert.equal(summary.vsFollowAll, Math.round((summary.pnl - summary.followAllPnl!) * 100) / 100);
  assert.ok(summary.bySport.length >= 2);

  // manual settlement for a voided/different-line bet — personal only
  const voided = await setBetResult(OWNER, mmaLoss.id, "void");
  assert.ok(voided.ok);
  if (voided.ok) {
    assert.equal(voided.bet.result, "void");
    assert.equal(voided.bet.pnl, 0);
  }
  assert.equal((await listBets(OWNER)).summary.staked, 3, "a voided bet is not counted as risked");
  const [stillLoss] = await db.select().from(predictions).where(eq(predictions.id, mmaLoss.id));
  assert.equal(stillLoss.outcome, "loss", "the shared ledger is untouched");
  await setBetResult(OWNER, mmaLoss.id, null);
  assert.equal((await listBets(OWNER)).bets.find((x) => x.predictionId === mmaLoss.id)!.result, "loss");

  // validation
  for (const bad of [{ predictionId: bos.id, stake: 0, odds: -110 }, { predictionId: bos.id, stake: 1, odds: 50 }, { predictionId: bos.id, stake: 1, odds: -110.5 }, { predictionId: 0, stake: 1, odds: -110 }, { predictionId: bos.id, stake: 999, odds: -110 }, null]) {
    const r = await upsertBet(OWNER, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal((await upsertBet(OWNER, { predictionId: 999999, stake: 1, odds: -110 })).ok, false);

  // CSV export
  const csv = betsToCsv(bets);
  assert.match(csv.split("\n")[0], /date,sport,matchup,pick/);
  assert.equal(csv.split("\n").length, 4);

  // removing a bet
  assert.equal(await deleteBet(OWNER, mmaWin.id), true);
  assert.equal(await deleteBet(OWNER, mmaWin.id), false);
  assert.equal((await listBets(OWNER)).bets.length, 2);
});

test("a pending pick tracks as pending exposure, then settles when graded", async () => {
  state.phase = "pre";
  const [p] = await db
    .insert(predictions)
    .values({ ownerId: OWNER, dedupeKey: "tracker-pending", runId: run1, sortOrder: 50, slateDate: D, sport: "nba", eventId: "E9", matchup: "A @ B", category: "moneyline", pick: "B ML", lineLabel: "ML -150", odds: -150, units: 1, confidence: 60, edge: 3, modelProb: 0.62, grade: { side: "home", line: null }, startTime: new Date(Date.now() + 3600_000) })
    .returning();
  const r = await upsertBet(OWNER, { predictionId: p.id, stake: 2, odds: -120 });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.bet.result, "pending");
  assert.equal(r.bet.late, false);
  assert.equal(r.bet.pnl, 0);
  assert.ok(Math.abs(r.bet.evAtPrice! - (0.62 * (100 / 120) - 0.38)) < 1e-3);
  const s = (await listBets(OWNER)).summary;
  assert.equal(s.pending, 1);
  assert.equal(s.atRisk, 2);
  await db.update(predictions).set({ outcome: "win" }).where(eq(predictions.id, p.id));
  const after = await listBets(OWNER);
  assert.equal(after.bets.find((b) => b.predictionId === p.id)!.pnl, 1.667);
  state.phase = "final";
});

// ---------------------------------------------------------------------------
test("API privacy: workspace ids never leave the server; the tracker refuses anonymous callers", async () => {
  const runsRoute = await import("../src/app/api/runs/route");
  const res = await runsRoute.GET(new NextRequest("http://x/api/runs"));
  const text = await res.text();
  assert.ok(text.length > 100);
  assert.ok(!text.includes(OWNER), "owner id must not appear anywhere in /api/runs");
  assert.ok(!text.includes('"ownerId"'));
  const parsed = JSON.parse(text) as { runs: { predictions: Record<string, unknown>[] }[] };
  assert.ok(parsed.runs.length > 0);
  for (const r of parsed.runs) for (const p of r.predictions) assert.ok(!("ownerId" in p));

  const bets = await import("../src/app/api/bets/route");
  // no workspace header → refused (it would otherwise land in the shared "house" workspace)
  const anon = await bets.GET(new NextRequest("http://x/api/bets"));
  assert.equal(anon.status, 400);
  const anonPost = await bets.POST(new NextRequest("http://x/api/bets", { method: "POST", body: JSON.stringify({ predictionId: 1, stake: 1, odds: -110 }) }));
  assert.equal(anonPost.status, 400);

  // with a header, the person sees exactly their own bets
  const mine = await bets.GET(new NextRequest("http://x/api/bets", { headers: { "x-neonslip-owner": OWNER } }));
  assert.equal(mine.status, 200);
  const body = (await mine.json()) as { bets: { predictionId: number }[]; summary: { total: number } };
  assert.equal(body.summary.total, body.bets.length);
  const theirs = await bets.GET(new NextRequest("http://x/api/bets", { headers: { "x-neonslip-owner": OTHER } }));
  const t = (await theirs.json()) as { bets: unknown[] };
  assert.equal(t.bets.length, 1);

  // POST → PATCH → CSV → DELETE through the real handlers
  const [anyPred] = await db.select().from(predictions).limit(1);
  const mk = (method: string, body?: unknown, qs = "") =>
    new NextRequest(`http://x/api/bets${qs}`, { method, headers: { "x-neonslip-owner": "wapitestowner01" }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await bets.POST(mk("POST", { predictionId: anyPred.id, stake: 1, odds: -110 }))).status, 200);
  assert.equal((await bets.POST(mk("POST", { predictionId: anyPred.id, stake: -1, odds: -110 }))).status, 400);
  assert.equal((await bets.PATCH(mk("PATCH", { predictionId: anyPred.id, result: "push" }))).status, 200);
  assert.equal((await bets.PATCH(mk("PATCH", { predictionId: anyPred.id, result: "banana" }))).status, 400);
  const csv = await bets.GET(mk("GET", undefined, "?format=csv"));
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(await csv.text(), /push/);
  assert.equal((await bets.DELETE(mk("DELETE", undefined, `?predictionId=${anyPred.id}`))).status, 200);
});

test("the agents API edits only the house roster (it used to rewrite every workspace's copy)", async () => {
  // a second workspace with its own copy of an agent
  await db.insert(agents).values({ id: `${OTHER}:scout-quant`, ownerId: OTHER, agentKey: "scout-quant", codename: "QUANT", layer: "scout", sortOrder: 1, title: "t", job: "j", prompt: "THEIR PRIVATE PROMPT", model: "m", rating: 1500, promptVersion: 5 });
  process.env.ADMIN_OWNER_ID = "wadminowner0001";
  const route = await import("../src/app/api/agents/route");
  const res = await route.PATCH(new NextRequest("http://x/api/agents", { method: "PATCH", headers: { "x-neonslip-owner": "wadminowner0001" }, body: JSON.stringify({ id: "scout-quant", prompt: "HOUSE EDIT — operator tuned playbook text" }) }));
  assert.equal(res.status, 200);
  const rows = await db.select().from(agents).where(eq(agents.agentKey, "scout-quant"));
  assert.equal(rows.find((r) => r.ownerId === "house")!.prompt, "HOUSE EDIT — operator tuned playbook text");
  assert.equal(rows.find((r) => r.ownerId === OTHER)!.prompt, "THEIR PRIVATE PROMPT");
  // reset restores the built-in playbook and archives what it replaced
  const reset = await route.POST(new NextRequest("http://x/api/agents", { method: "POST", headers: { "x-neonslip-owner": "wadminowner0001" }, body: JSON.stringify({ id: "scout-quant" }) }));
  assert.equal(reset.status, 200);
  const [house] = await db.select().from(agents).where(sql`${agents.ownerId} = 'house' and ${agents.agentKey} = 'scout-quant'`);
  assert.match(house.prompt, /market-anchored/i);
  assert.ok(house.improvements.some((i) => /HOUSE EDIT/.test(i.detail)), "the replaced prompt is archived");
  // non-admins are refused
  const denied = await route.PATCH(new NextRequest("http://x/api/agents", { method: "PATCH", headers: { "x-neonslip-owner": "wrandomvisitor01" }, body: JSON.stringify({ id: "scout-quant", prompt: "a prompt long enough to pass validation" }) }));
  assert.equal(denied.status, 403);
});
