import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

type DB = ReturnType<typeof drizzle>;

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlDb?: DB;
};

function createDb(): DB {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return drizzle(
    new Pool({
      connectionString: databaseUrl,
      max: 4,
      idleTimeoutMillis: 30_000,
    }),
  );
}

function resolveDb(): DB {
  globalForDb.__arenaNextJsPostgresqlDb ??= createDb();
  return globalForDb.__arenaNextJsPostgresqlDb;
}

/**
 * Lazy database handle.
 * Importing this module never connects and never throws — the pool is only
 * created the first time a query actually runs. This keeps `next build`
 * (page-data collection) green on hosts where DATABASE_URL is injected at
 * runtime only, while real requests still fail loudly if it's missing.
 */
export const db = new Proxy({} as DB, {
  get(_target, prop) {
    const real = resolveDb() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop);
    return typeof value === "function" ? (value as Function).bind(real) : value;
  },
});

/** Escape hatch for raw pool access (health checks, diagnostics). */
export function rawDb(): DB {
  return resolveDb();
}
