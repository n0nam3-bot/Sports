import { test, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { LEGACY_DDL } from "./legacy-schema";

const client = new PGlite();
const pg = drizzle(client);
(globalThis as unknown as { __arenaNextJsPostgresqlDb: unknown }).__arenaNextJsPostgresqlDb = pg;

const rows = async (q: string): Promise<Record<string, unknown>[]> =>
  (await pg.execute(sql.raw(q))).rows as Record<string, unknown>[];

before(async () => {
  // A database exactly as a deployed v4 app left it…
  for (const ddl of LEGACY_DDL) await pg.execute(sql.raw(ddl));
  // …with real-looking data in it.
  await pg.execute(sql.raw(`INSERT INTO runs (owner_id, slate_date, sports, status, mode) VALUES ('house', '2026-10-10', '["ncaaf"]'::jsonb, 'completed', 'heuristic')`));
  await pg.execute(sql.raw(`INSERT INTO predictions
    (owner_id, dedupe_key, run_id, sort_order, slate_date, sport, event_id, matchup, category, pick, line_label, odds, units, confidence, edge, outcome, final_score, grade, agents)
    VALUES ('house', 'legacy-key-1', 1, 0, '2026-10-10', 'ncaaf', 'E1', 'AAA @ BBB', 'spread', 'BBB -3.5', 'spread -3.5', -110, 1.5, 64, 6.2, 'win', 'AAA 20 — BBB 31', '{"side":"home","line":-3.5}'::jsonb, '["QUANT","MEDIC","STRATEGA","CONTRARIAN","COMMISSIONER","RISK","HISTORIAN"]'::jsonb)`));
  // legacy agents incl. the retired MATCHUP scout and a drifted, self-rewritten prompt
  const legacyAgent = (id: string, code: string, layer: string, order: number, prompt: string, w = 40, l = 38) =>
    `INSERT INTO agents (id, owner_id, agent_key, codename, layer, sort_order, title, job, prompt, model, rating, wins, losses, pushes, improvements)
     VALUES ('${id}', 'house', '${id}', '${code}', '${layer}', ${order}, 'T', 'J', '${prompt}', 'heuristic-core', 1488.5, ${w}, ${l}, 2, '[]'::jsonb)`;
  await pg.execute(sql.raw(legacyAgent("scout-quant", "QUANT", "scout", 1, "You are QUANT. SELF-CORRECTION LOG: raise edge thresholds...")));
  await pg.execute(sql.raw(legacyAgent("scout-matchup", "MATCHUP", "scout", 5, "You are MATCHUP.")));
  await pg.execute(sql.raw(legacyAgent("council-risk", "RISK", "council", 17, "You are RISK.")));
});

test("the legacy database really lacks the v5 columns (so the test means something)", async () => {
  const cols = await rows(`SELECT column_name FROM information_schema.columns WHERE table_name='predictions'`);
  const names = cols.map((c) => c.column_name);
  assert.ok(!names.includes("model_prob"));
  assert.ok(!names.includes("engine_version"));
  const t = await rows(`SELECT table_name FROM information_schema.tables WHERE table_name='user_bets'`);
  assert.equal(t.length, 0);
});

test("ensureSchema upgrades a v4 database in place, keeping every legacy row", async () => {
  const { ensureSchema } = await import("../src/lib/schema");
  await ensureSchema();
  await ensureSchema(); // idempotent

  const names = (await rows(`SELECT column_name FROM information_schema.columns WHERE table_name='predictions'`)).map((c) => c.column_name);
  for (const c of ["model_prob", "market_prob", "price_source", "min_price", "engine_version"]) assert.ok(names.includes(c), c);
  assert.ok((await rows(`SELECT column_name FROM information_schema.columns WHERE table_name='runs'`)).some((c) => c.column_name === "discipline"));
  assert.ok((await rows(`SELECT column_name FROM information_schema.columns WHERE table_name='agents'`)).some((c) => c.column_name === "prompt_version"));
  assert.equal((await rows(`SELECT 1 FROM information_schema.tables WHERE table_name='user_bets'`)).length, 1);

  // legacy prediction survived, flagged as a v4 book-priced pick
  const [p] = await rows(`SELECT pick, outcome, engine_version, price_source, model_prob, min_price, confidence FROM predictions WHERE dedupe_key='legacy-key-1'`);
  assert.equal(p.pick, "BBB -3.5");
  assert.equal(p.outcome, "win");
  assert.equal(p.engine_version, 4);
  assert.equal(p.price_source, "book");
  assert.equal(p.model_prob, null);
  assert.equal(p.min_price, null);
  assert.equal(p.confidence, 64);
  // legacy run defaults to a standard discipline
  assert.equal((await rows(`SELECT discipline FROM runs LIMIT 1`))[0].discipline, "standard");
});

test("agents: playbooks upgrade, the retired scout is removed, history is archived not lost", async () => {
  const { ensureAgentsSeeded, AGENT_DEFS, PROMPT_VERSION } = await import("../src/lib/agents");
  await ensureAgentsSeeded("house");
  await ensureAgentsSeeded("house"); // idempotent: no duplicate log entries

  const all = await rows(`SELECT agent_key, codename, prompt, prompt_version, rating, wins, losses, improvements FROM agents WHERE owner_id='house'`);
  assert.equal(all.length, AGENT_DEFS.length, "exactly the 17 current agents");
  assert.ok(!all.some((a) => a.agent_key === "scout-matchup"), "retired agent removed");

  const quant = all.find((a) => a.agent_key === "scout-quant")!;
  assert.equal(quant.prompt_version, PROMPT_VERSION);
  assert.ok(!(quant.prompt as string).includes("SELF-CORRECTION"), "drifted prompt replaced");
  assert.match(quant.prompt as string, /market-anchored/i);
  assert.equal(quant.rating, 1500, "fresh slate for the new engine");
  assert.equal(quant.wins, 0);
  const log = quant.improvements as { reason: string; detail: string }[];
  assert.equal(log.length, 1, "archived exactly once");
  assert.match(log[0].reason, /upgraded to v5/);
  assert.match(log[0].detail, /40W–38L/, "the old record is preserved in the log");
  assert.match(log[0].detail, /SELF-CORRECTION LOG/, "the replaced prompt is preserved in the log");
});

test("the pre-existing prediction is still readable through the app's own schema", async () => {
  const { db } = await import("../src/db");
  const { predictions } = await import("../src/db/schema");
  const all = await db.select().from(predictions);
  assert.equal(all.length, 1);
  assert.equal(all[0].engineVersion, 4);
  assert.equal(all[0].modelProb, null);
  assert.deepEqual(all[0].agents.slice(0, 2), ["QUANT", "MEDIC"]);
});
