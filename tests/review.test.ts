import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyReviews,
  collectReviews,
  digestFor,
  MAX_BOOST,
  MAX_TOTAL_TRIM,
  parseReviews,
} from "../src/lib/review";
import type { Candidate } from "../src/lib/candidate";
import { bucketOf } from "../src/lib/candidate";
import { evPerUnit } from "../src/lib/edge";
import { teamGame } from "./helpers";

let n = 0;
function cand(over: Partial<Candidate> = {}): Candidate {
  const g = teamGame();
  const c: Candidate = {
    id: ++n, game: g, category: "spread", pick: "BOS -3.5", lineLabel: "x", odds: -110,
    priceSource: "book", modelProb: 0.56, pPush: 0, marketProb: 0.5, fairOdds: -127, minOdds: null,
    ev: 0, trust: 1, signals: ["QUANT"], agree: 1, thesis: "", grade: { side: "home", line: -3.5 },
    bucket: bucketOf("nba", "spread"), cluster: "side", rank: 5, ...over,
  };
  c.ev = evPerUnit(c.modelProb, c.odds, 0);
  return c;
}

const R = (over: Record<string, unknown>) => ({ id: 1, verdict: "trim", deltaProb: -0.02, reason: "Starting guard confirmed out after the report", ...over });

test("parseReviews drops anything it cannot trust", () => {
  const valid = new Set([1, 2, 3]);
  const parsed = parseReviews(
    {
      reviews: [
        R({ id: 1 }),
        R({ id: 99 }), // not a candidate we showed
        R({ id: 2, reason: "meh" }), // no concrete reason → no effect
        R({ id: 3, verdict: "banana" }),
        R({ id: 1 }), // duplicate id
        null,
        "string",
      ],
    },
    valid,
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 1);
  assert.deepEqual(parseReviews("not an object", valid), []);
  assert.deepEqual(parseReviews({ reviews: "nope" }, valid), []);
  assert.deepEqual(parseReviews(null, valid), []);
});

test("deltas are clamped: trims ≤ 5 points, boosts ≤ 2 points, vetoes carry no delta", () => {
  const valid = new Set([1, 2, 3, 4]);
  const parsed = parseReviews(
    {
      reviews: [
        R({ id: 1, verdict: "trim", deltaProb: -0.4 }),
        R({ id: 2, verdict: "keep", deltaProb: 0.3 }),
        R({ id: 3, verdict: "veto", deltaProb: 0.5 }),
        R({ id: 4, verdict: "trim", deltaProb: 0.03 }), // wrong sign for a trim → treated as a trim of that size
      ],
    },
    valid,
  );
  const by = Object.fromEntries(parsed.map((p) => [p.id, p]));
  assert.equal(by[1].deltaProb, -0.05);
  assert.equal(by[2].deltaProb, MAX_BOOST);
  assert.equal(by[3].deltaProb, 0);
  assert.equal(by[4].deltaProb, -0.03);
});

test("applying a trim lowers probability and EV; a boost can never be large", () => {
  const c = cand({ modelProb: 0.56 });
  const evBefore = c.ev;
  applyReviews([c], [{ source: "NBA_EXPERT", review: { id: c.id, verdict: "trim", deltaProb: -0.03, reason: "Star player listed doubtful at 6pm" } }]);
  assert.ok(Math.abs(c.modelProb - 0.53) < 1e-9);
  assert.ok(c.ev < evBefore);
  assert.match(c.discount ?? "", /NBA_EXPERT/);

  const d = cand({ modelProb: 0.55 });
  applyReviews([d], [
    { source: "A", review: { id: d.id, verdict: "keep", deltaProb: 0.02, reason: "Confirmed lineup supports the model" } },
    { source: "B", review: { id: d.id, verdict: "keep", deltaProb: 0.02, reason: "Rest edge understated by the model" } },
  ]);
  assert.ok(d.modelProb <= 0.55 + MAX_BOOST + 1e-9, `boost stacked to ${d.modelProb}`);
});

test("stacked trims from several reviewers are capped in total", () => {
  const c = cand({ modelProb: 0.58 });
  const revs = ["A", "B", "C", "D"].map((s) => ({
    source: s,
    review: { id: c.id, verdict: "trim" as const, deltaProb: -0.05, reason: "Concrete concern raised by this reviewer" },
  }));
  applyReviews([c], revs);
  assert.ok(c.modelProb >= 0.58 - MAX_TOTAL_TRIM - 1e-9, `${c.modelProb}`);
});

test("a model that vetoes everything cannot wipe out the card", () => {
  const cs = Array.from({ length: 10 }, () => cand());
  const revs = cs.map((c) => ({ source: "CONTRARIAN", review: { id: c.id, verdict: "veto" as const, deltaProb: 0, reason: "Everything looks risky today honestly" } }));
  const r = applyReviews(cs, revs);
  assert.equal(r.vetoes, 4, "at most 40% of the shortlist");
  assert.equal(cs.filter((c) => c.vetoed).length, 4);
});

test("reviews for unknown candidates are ignored, not applied", () => {
  const c = cand();
  const before = c.modelProb;
  const r = applyReviews([c], [{ source: "X", review: { id: 424242, verdict: "trim", deltaProb: -0.05, reason: "A concrete but misdirected remark" } }]);
  assert.equal(c.modelProb, before);
  assert.equal(r.ignored, 1);
});

test("the digest shows ids, prices and probabilities — and flags model prices", () => {
  const a = cand({ pick: "BOS -3.5" });
  const b = cand({ pick: "Some Fighter ML", priceSource: "model", marketProb: null });
  const text = digestFor([a, b]);
  assert.match(text, new RegExp(`#${a.id} BOS -3\\.5`));
  assert.match(text, /vs market 50\.0%/);
  assert.match(text, /\(model price\)/);
});

test("with no model configured the stage degrades gracefully (no calls, no effect)", async () => {
  const before = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, GEMINI_API_KEY: process.env.GEMINI_API_KEY, XAI_API_KEY: process.env.XAI_API_KEY, OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL };
  for (const k of Object.keys(before)) delete process.env[k];
  try {
    const c = cand();
    const out = await collectReviews({ jobs: [{ agentId: "NBA_EXPERT", prompt: "p", cands: [c] }], keys: {}, enabled: true, budgetMs: 5000 });
    assert.equal(out.reviews.length, 0);
    assert.equal(out.log[0].ok, false);
    assert.match(out.log[0].note, /no model/);
  } finally {
    for (const [k, v] of Object.entries(before)) if (v != null) process.env[k] = v;
  }
});
