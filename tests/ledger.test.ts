import { test } from "node:test";
import assert from "node:assert/strict";
import { isLogRun, ledgerCount, runKind, splitRuns, type RunLike } from "../src/components/ledger";

const fresh = { carried: false };
const standing = { carried: true };
let n = 0;
const run = (over: Partial<RunLike> = {}): RunLike & { id: number } => ({ id: ++n, status: "completed", predictions: [], ...over });

test("runKind tells a release, a repeat-only run, a pass, a failure and a run in progress apart", () => {
  assert.equal(runKind(run({ productive: true, predictions: [fresh] })), "released");
  // new picks alongside standing ones is still a release
  assert.equal(runKind(run({ productive: true, predictions: [fresh, standing] })), "released");
  // nothing new, but earlier picks still stand: the "NOTHING NEW — N EARLIER PICKS STAND" run
  assert.equal(runKind(run({ productive: false, predictions: [standing, standing] })), "nothing-new");
  // nothing new and nothing standing: a pass
  assert.equal(runKind(run({ productive: false, predictions: [] })), "pass");
  assert.equal(runKind(run({ status: "failed" })), "failed");
  assert.equal(runKind(run({ status: "running" })), "running");
});

test("without the server's flag (the single-run endpoint has none) the picks themselves decide", () => {
  assert.equal(runKind(run({ predictions: [fresh] })), "released");
  assert.equal(runKind(run({ predictions: [standing] })), "nothing-new");
  assert.equal(runKind(run({ predictions: [] })), "pass");
  assert.equal(isLogRun(run({ predictions: [standing] })), true);
  assert.equal(isLogRun(run({ predictions: [fresh, standing] })), false);
});

test("when the flag is present it wins", () => {
  // contradictory on purpose: the server's definition ("has rows of its own") is the contract
  assert.equal(isLogRun(run({ productive: true, predictions: [] })), false);
  assert.equal(isLogRun(run({ productive: false, predictions: [fresh] })), true);
});

test("only runs that are over and released nothing new belong in the Log", () => {
  assert.equal(isLogRun(run({ productive: false })), true, "a pass");
  assert.equal(isLogRun(run({ productive: false, predictions: [standing] })), true, "nothing new");
  assert.equal(isLogRun(run({ productive: false, status: "failed" })), true, "a failure that left nothing");
  assert.equal(isLogRun(run({ productive: true })), false, "a release");
  assert.equal(isLogRun(run({ productive: false, status: "running" })), false, "still in progress — it may yet release something");
  assert.equal(isLogRun(run({ productive: true, status: "failed" })), false, "a failure that left picks behind keeps them visible and gradable");
});

test("splitRuns puts every run in exactly one group and keeps the order", () => {
  const runs = [
    run({ productive: true, predictions: [fresh] }),
    run({ productive: false }),
    run({ productive: false, status: "running" }),
    run({ productive: false, predictions: [standing] }),
    run({ productive: true, predictions: [fresh, standing] }),
    run({ productive: false, status: "failed" }),
  ];
  const { ledger, log } = splitRuns(runs);
  assert.equal(ledger.length + log.length, runs.length);
  assert.deepEqual(ledger.map((r) => r.id), [runs[0].id, runs[2].id, runs[4].id]);
  assert.deepEqual(log.map((r) => r.id), [runs[1].id, runs[3].id, runs[5].id]);
  assert.deepEqual(splitRuns([]), { ledger: [], log: [] });
});

test("the Ledger badge counts finished runs that released something — not passes, repeats, failures or runs in progress", () => {
  assert.equal(
    ledgerCount([
      run({ productive: true, predictions: [fresh] }), // counts
      run({ productive: true, predictions: [fresh] }), // counts
      run({ productive: false }), // pass
      run({ productive: false, predictions: [standing] }), // nothing new
      run({ productive: false, status: "failed" }),
      run({ productive: false, status: "running" }),
      run({ productive: true, status: "failed", predictions: [fresh] }), // not "completed"
    ]),
    2,
  );
  assert.equal(ledgerCount([]), 0);
});
