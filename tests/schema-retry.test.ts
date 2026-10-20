import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// Its own file on purpose: node:test gives every file a fresh process, so the
// module-level bootstrap cache in lib/schema.ts starts out empty.
test("a transient bootstrap failure is retried on the next request, not cached forever", async () => {
  // The old code cached a rejected promise, so one Neon cold-start hiccup wedged
  // every request on that server instance until it recycled.
  const real = drizzle(new PGlite());
  let calls = 0;
  (globalThis as unknown as Record<string, unknown>).__arenaNextJsPostgresqlDb = new Proxy(real, {
    get(target, prop) {
      if (prop === "execute") {
        return async (...args: unknown[]) => {
          calls++;
          if (calls === 1) throw new Error("connection reset by peer");
          return (target.execute as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return Reflect.get(target, prop);
    },
  });

  const { ensureSchema } = await import("../src/lib/schema");
  await assert.rejects(ensureSchema(), /connection reset/);
  await ensureSchema(); // would still reject if the failure had been cached
  assert.ok(calls > 3, `bootstrap re-ran (${calls} statements)`);
  const after = calls;
  await ensureSchema(); // a success IS cached
  assert.equal(calls, after);
});
