import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFightResult,
  describeFight,
  roundsStarted,
  settleMma,
  settleTeam,
  type FightFinalLike,
  type FightStatsLike,
} from "../src/lib/grading";
import type { MmaGrade } from "../src/db/schema";

// ---------------------------------------------------------------------------
// fight result classification
// ---------------------------------------------------------------------------
test("classifyFightResult reads ESPN's free text", () => {
  assert.equal(classifyFightResult("KO/TKO"), "ko");
  assert.equal(classifyFightResult("TKO (Doctor Stoppage)"), "ko");
  assert.equal(classifyFightResult("TKO (Punches)"), "ko");
  assert.equal(classifyFightResult("Submission"), "sub");
  assert.equal(classifyFightResult("Submission (Rear Naked Choke)"), "sub");
  assert.equal(classifyFightResult("Decision - Unanimous"), "dec");
  assert.equal(classifyFightResult("Split Decision"), "dec");
  assert.equal(classifyFightResult("Majority Decision"), "dec");
  assert.equal(classifyFightResult("Technical Decision"), "dec"); // must not be read as a TKO
  assert.equal(classifyFightResult("Draw"), "draw");
  assert.equal(classifyFightResult("Majority Draw"), "draw");
  assert.equal(classifyFightResult("No Contest"), "nc");
  assert.equal(classifyFightResult("Disqualification"), "dq");
  assert.equal(classifyFightResult("Final"), "unknown");
  assert.equal(classifyFightResult(undefined, null, ""), "unknown");
  // several candidate strings are combined
  assert.equal(classifyFightResult("Final", undefined, "KO/TKO"), "ko");
});

test("roundsStarted treats a boundary stoppage as ending the previous round", () => {
  assert.equal(roundsStarted(0.5), 1);
  assert.equal(roundsStarted(2.5), 1);
  assert.equal(roundsStarted(5.0), 1); // corner stoppage between R1 and R2
  assert.equal(roundsStarted(5.02), 2);
  assert.equal(roundsStarted(7.5), 2);
  assert.equal(roundsStarted(10.0), 2);
  assert.equal(roundsStarted(15.0), 3);
  assert.equal(roundsStarted(0), 1);
});

// ---------------------------------------------------------------------------
// MMA settlement
// ---------------------------------------------------------------------------
const fight = (over: Partial<FightFinalLike> = {}): FightFinalLike => ({
  homeScore: 0,
  awayScore: 1,
  winnerName: "Away Guy",
  endRound: 3,
  elapsedMinutes: 15,
  scheduledRounds: 3,
  wentDistance: true,
  method: "dec",
  ...over,
});
const kor1 = (over: Partial<FightFinalLike> = {}) =>
  fight({ endRound: 1, elapsedMinutes: 2.0, wentDistance: false, method: "ko", ...over });

test("moneyline: win, loss, draw → push, no-contest → void", () => {
  assert.equal(settleMma({ kind: "ml", fighter: "away" }, fight()), "win");
  assert.equal(settleMma({ kind: "ml", fighter: "home" }, fight()), "loss");
  const draw = fight({ homeScore: 0, awayScore: 0, method: "draw" });
  assert.equal(settleMma({ kind: "ml", fighter: "home" }, draw), "push");
  const nc = fight({ homeScore: 0, awayScore: 0, method: "nc", wentDistance: false });
  assert.equal(settleMma({ kind: "ml", fighter: "home" }, nc), "void");
});

test("no contest voids every market", () => {
  const nc = fight({ homeScore: 0, awayScore: 0, method: "nc", wentDistance: false, elapsedMinutes: 3 });
  const markets: MmaGrade[] = [
    { kind: "rounds", dir: "over", line: 0.5 },
    { kind: "distance", yes: true },
    { kind: "start_round", round: 2, yes: true },
    { kind: "spread", fighter: "away", line: -1.5 },
    { kind: "method", fighter: "away", method: "ko" },
    { kind: "sigstr", fighter: "away", dir: "over", line: 10.5 },
  ];
  for (const m of markets) assert.equal(settleMma(m, nc), "void", m.kind);
});

test("total rounds: decisions, early finishes, exact-midpoint push", () => {
  const over = (line: number): MmaGrade => ({ kind: "rounds", dir: "over", line });
  const under = (line: number): MmaGrade => ({ kind: "rounds", dir: "under", line });
  // full decision: every line is cleared
  assert.equal(settleMma(over(2.5), fight()), "win");
  assert.equal(settleMma(under(2.5), fight()), "loss");
  // R1 finish at 2:00 → under 0.5 wins, over 0.5 loses, over 1.5 loses
  assert.equal(settleMma(under(0.5), kor1()), "win");
  assert.equal(settleMma(over(0.5), kor1()), "loss");
  assert.equal(settleMma(over(1.5), kor1()), "loss");
  // exactly 2:30 of round 1 is the 0.5 line → push
  assert.equal(settleMma(over(0.5), kor1({ elapsedMinutes: 2.5 })), "push");
  // R2 at 3:00 (8.0 min) clears 1.5 but not 2.5
  const r2 = fight({ endRound: 2, elapsedMinutes: 8, wentDistance: false, method: "sub" });
  assert.equal(settleMma(over(1.5), r2), "win");
  assert.equal(settleMma(over(2.5), r2), "loss");
  // five-round line
  const r5 = fight({ scheduledRounds: 5, endRound: 5, elapsedMinutes: 25, method: "dec" });
  assert.equal(settleMma(over(4.5), r5), "win");
});

test("a decision is graded as the full scheduled time even if ESPN's clock says 0:00", () => {
  // The clock quirk: ESPN reports the final round at 0:00 → naive elapsed = 10 min.
  const quirky = fight({ endRound: 3, elapsedMinutes: 10, wentDistance: true, method: "dec" });
  assert.equal(settleMma({ kind: "rounds", dir: "over", line: 2.5 }, quirky), "win");
  assert.equal(settleMma({ kind: "rounds", dir: "under", line: 2.5 }, quirky), "loss");
  assert.equal(settleMma({ kind: "distance", yes: true }, quirky), "win");
});

test("goes the distance", () => {
  assert.equal(settleMma({ kind: "distance", yes: true }, fight()), "win");
  assert.equal(settleMma({ kind: "distance", yes: false }, fight()), "loss");
  assert.equal(settleMma({ kind: "distance", yes: false }, kor1()), "win");
  assert.equal(settleMma({ kind: "distance", yes: true }, kor1()), "loss");
  // a draw means all rounds were fought
  const draw = fight({ homeScore: 0, awayScore: 0, method: "draw" });
  assert.equal(settleMma({ kind: "distance", yes: true }, draw), "win");
});

test("fight to start round N", () => {
  const start = (round: number, yes: boolean): MmaGrade => ({ kind: "start_round", round, yes });
  assert.equal(settleMma(start(2, true), kor1()), "loss"); // finished in R1
  assert.equal(settleMma(start(2, false), kor1()), "win");
  const r2 = fight({ endRound: 2, elapsedMinutes: 8, wentDistance: false, method: "ko" });
  assert.equal(settleMma(start(2, true), r2), "win");
  assert.equal(settleMma(start(3, true), r2), "loss");
  // stopped between rounds: R2 never started even though ESPN says period 2
  const between = fight({ endRound: 2, elapsedMinutes: 5, wentDistance: false, method: "ko" });
  assert.equal(settleMma(start(2, true), between), "loss");
  assert.equal(settleMma(start(2, false), between), "win");
  // went to a decision in a 5-rounder: every round started
  const five = fight({ scheduledRounds: 5, endRound: 5, elapsedMinutes: 25, method: "dec" });
  assert.equal(settleMma(start(5, true), five), "win");
});

test("finish handicap (spread)", () => {
  const sp = (fighter: "home" | "away", line: -1.5 | 1.5): MmaGrade => ({ kind: "spread", fighter, line });
  // away wins by KO
  assert.equal(settleMma(sp("away", -1.5), kor1()), "win");
  assert.equal(settleMma(sp("home", 1.5), kor1()), "loss"); // loser got finished
  assert.equal(settleMma(sp("home", -1.5), kor1()), "loss");
  assert.equal(settleMma(sp("away", 1.5), kor1()), "win");
  // away wins by decision: -1.5 fails, the loser's +1.5 covers
  assert.equal(settleMma(sp("away", -1.5), fight()), "loss");
  assert.equal(settleMma(sp("home", 1.5), fight()), "win");
  // a draw: nobody finished anybody
  const draw = fight({ homeScore: 0, awayScore: 0, method: "draw" });
  assert.equal(settleMma(sp("away", -1.5), draw), "loss");
  assert.equal(settleMma(sp("away", 1.5), draw), "win");
  // DQ is voided
  const dq = fight({ method: "dq", wentDistance: false });
  assert.equal(settleMma(sp("away", -1.5), dq), "void");
});

test("method of victory", () => {
  const m = (fighter: "home" | "away", method: "ko" | "sub" | "dec"): MmaGrade => ({ kind: "method", fighter, method });
  assert.equal(settleMma(m("away", "ko"), kor1()), "win");
  assert.equal(settleMma(m("away", "sub"), kor1()), "loss");
  assert.equal(settleMma(m("away", "dec"), kor1()), "loss");
  assert.equal(settleMma(m("home", "ko"), kor1()), "loss"); // picked the loser
  assert.equal(settleMma(m("away", "dec"), fight()), "win");
  assert.equal(settleMma(m("away", "ko"), fight()), "loss");
  assert.equal(settleMma(m("away", "sub"), fight({ method: "sub", wentDistance: false, endRound: 2, elapsedMinutes: 7 })), "win");
  // draw: no fighter won by anything
  const draw = fight({ homeScore: 0, awayScore: 0, method: "draw" });
  assert.equal(settleMma(m("away", "dec"), draw), "loss");
  // a finish whose type ESPN did not report can't be settled as KO vs sub yet
  const unknownFinish = fight({ method: "unknown", wentDistance: false, endRound: 1, elapsedMinutes: 3 });
  assert.equal(settleMma(m("away", "ko"), unknownFinish), null);
  assert.equal(settleMma(m("away", "dec"), unknownFinish), "loss");
  assert.equal(settleMma(m("away", "dec"), fight({ method: "unknown", wentDistance: true })), "win");
});

test("significant strikes and takedowns need the stat feed", () => {
  const stats: FightStatsLike = {
    away: { sigStrikesLanded: 54, takedownsLanded: 0 },
    home: { sigStrikesLanded: 31, takedownsLanded: 2 },
  };
  const sig = (fighter: "home" | "away", dir: "over" | "under", line: number): MmaGrade => ({ kind: "sigstr", fighter, dir, line });
  const td = (fighter: "home" | "away", dir: "over" | "under", line: number): MmaGrade => ({ kind: "td", fighter, dir, line });
  assert.equal(settleMma(sig("away", "over", 50.5), fight(), stats), "win");
  assert.equal(settleMma(sig("away", "under", 50.5), fight(), stats), "loss");
  assert.equal(settleMma(sig("home", "over", 40.5), fight(), stats), "loss");
  assert.equal(settleMma(td("away", "under", 0.5), fight(), stats), "win");
  assert.equal(settleMma(td("home", "over", 1.5), fight(), stats), "win");
  assert.equal(settleMma(sig("away", "over", 54), fight(), stats), "push");
  // stats not published → stay pending
  assert.equal(settleMma(sig("away", "over", 50.5), fight(), null), null);
  assert.equal(settleMma(sig("away", "over", 50.5), fight(), { away: null, home: null }), null);
  assert.equal(
    settleMma(td("away", "over", 0.5), fight(), { away: { sigStrikesLanded: 40, takedownsLanded: null }, home: null }),
    null,
  );
});

test("describeFight is readable", () => {
  assert.match(describeFight(kor1()), /Away Guy def\. — KO\/TKO R1 2:00/);
  assert.match(describeFight(fight()), /Decision/);
  const withStats = describeFight(fight(), {
    away: { sigStrikesLanded: 54, takedownsLanded: 1 },
    home: { sigStrikesLanded: 31, takedownsLanded: 2 },
  });
  assert.match(withStats, /sig\. strikes 54-31/);
  assert.match(withStats, /TD 1-2/);
});

// ---------------------------------------------------------------------------
// team sports (ported from the original grader)
// ---------------------------------------------------------------------------
const finalScore = (home: number, away: number, homeLine: number[] = [], awayLine: number[] = []) => ({
  homeAbbr: "BOS",
  awayAbbr: "NYK",
  homeScore: home,
  awayScore: away,
  homeLine,
  awayLine,
});

test("spread settles with the line on the chosen side", () => {
  const g = (side: "home" | "away", line: number) => ({ side, line });
  // BOS 110, NYK 104 → BOS won by 6
  const fs = finalScore(110, 104);
  assert.equal(settleTeam("spread", g("home", -5.5), fs)?.outcome, "win"); // 6 > 5.5
  assert.equal(settleTeam("spread", g("home", -3.5), fs)?.outcome, "win");
  assert.equal(settleTeam("spread", g("home", -6.5), fs)?.outcome, "loss"); // 6 < 6.5
  assert.equal(settleTeam("spread", g("away", 5.5), fs)?.outcome, "loss"); // loses by 6, needs ≤ 5
  assert.equal(settleTeam("spread", g("away", 6.5), fs)?.outcome, "win");
  assert.equal(settleTeam("spread", g("home", -6), fs)?.outcome, "push");
  assert.equal(settleTeam("spread", g("away", 6), fs)?.outcome, "push");
});

test("totals, moneyline (incl. ties), and team totals", () => {
  const fs = finalScore(110, 104); // total 214
  assert.equal(settleTeam("total", { side: "over", line: 213.5 }, fs)?.outcome, "win");
  assert.equal(settleTeam("total", { side: "under", line: 213.5 }, fs)?.outcome, "loss");
  assert.equal(settleTeam("total", { side: "over", line: 214 }, fs)?.outcome, "push");
  assert.equal(settleTeam("moneyline", { side: "home", line: null }, fs)?.outcome, "win");
  assert.equal(settleTeam("moneyline", { side: "away", line: null }, fs)?.outcome, "loss");
  // a tie returns the stake instead of silently counting as an away win
  assert.equal(settleTeam("moneyline", { side: "away", line: null }, finalScore(20, 20))?.outcome, "push");
  assert.equal(
    settleTeam("team_total", { side: "team_over", line: 108.5, teamAbbr: "BOS" }, fs)?.outcome,
    "win",
  );
  assert.equal(
    settleTeam("team_total", { side: "team_under", line: 105.5, teamAbbr: "NYK" }, fs)?.outcome,
    "win",
  );
  assert.equal(settleTeam("total", { side: "over", line: 213.5 }, fs)?.finalScore, "NYK 104 — BOS 110");
});

test("player props wait for the boxscore", () => {
  const g = { side: "team_over" as const, line: 24.5, player: "J Tatum", stat: "PTS" };
  assert.equal(settleTeam("player_prop", g, finalScore(110, 104), null), null);
  assert.equal(settleTeam("player_prop", g, finalScore(110, 104), 31)?.outcome, "win");
  assert.equal(settleTeam("player_prop", g, finalScore(110, 104), 20)?.outcome, "loss");
  assert.equal(settleTeam("player_prop", { ...g, line: 31 }, finalScore(110, 104), 31)?.outcome, "push");
});

test("segment markets settle off linescores", () => {
  // quarter sport: first half = Q1 + Q2
  const fs = finalScore(110, 104, [28, 30, 25, 27], [26, 22, 30, 26]); // 1H: home 58 away 48
  assert.equal(settleTeam("1h_total", { side: "over", line: 100.5, segment: "1H" }, fs)?.outcome, "win");
  assert.equal(settleTeam("1h_total", { side: "under", line: 100.5, segment: "1H" }, fs)?.outcome, "loss");
  assert.equal(settleTeam("1h_spread", { side: "home", line: -9.5, segment: "1H" }, fs)?.outcome, "win"); // 58-9.5 > 48
  assert.equal(settleTeam("1h_spread", { side: "home", line: -10, segment: "1H" }, fs)?.outcome, "push");
  // college halves have only two entries
  const ncaab = finalScore(70, 65, [35, 35], [30, 35]);
  assert.equal(settleTeam("1h_total", { side: "over", line: 64.5, segment: "1H" }, ncaab)?.outcome, "win");
  // first quarter / first period
  assert.equal(settleTeam("1q_total", { side: "over", line: 50.5, segment: "1Q" }, fs)?.outcome, "win");
  // first five innings of a baseball game
  const mlb = finalScore(5, 3, [0, 1, 0, 2, 0, 1, 1, 0, 0], [1, 0, 0, 0, 1, 0, 0, 1, 0]);
  assert.equal(settleTeam("f5_total", { side: "under", line: 5.5, segment: "F5" }, mlb)?.outcome, "win"); // F5: 3 + 2 = 5
  // NRFI: side "under" == no runs in the 1st
  assert.equal(settleTeam("nrfi", { side: "over", line: 0.5, segment: "1I" }, mlb)?.outcome, "win"); // 0 + 1 → runs scored
  assert.equal(settleTeam("nrfi", { side: "under", line: 0.5, segment: "1I" }, mlb)?.outcome, "loss");
  // linescore not published yet → stay pending
  assert.equal(settleTeam("1h_total", { side: "over", line: 100.5, segment: "1H" }, finalScore(110, 104))?.outcome, undefined);
});
