import { db } from "@/db";
import { sql } from "drizzle-orm";

// Idempotent bootstrap so the app installs itself against ANY empty Postgres
// (Neon/Supabase/Render...) without `drizzle-kit push` or a laptop terminal.
// Each statement mirrors the drizzle schema exactly and is safe to re-run
// on every cold start.

let bootstrapped: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  bootstrapped ??= (async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "agents" (
        "id" text PRIMARY KEY NOT NULL,
        "codename" text NOT NULL,
        "layer" text NOT NULL,
        "sort_order" integer DEFAULT 0 NOT NULL,
        "title" text NOT NULL,
        "job" text NOT NULL,
        "prompt" text NOT NULL,
        "model" text DEFAULT 'heuristic-core' NOT NULL,
        "rating" real DEFAULT 1500 NOT NULL,
        "wins" integer DEFAULT 0 NOT NULL,
        "losses" integer DEFAULT 0 NOT NULL,
        "pushes" integer DEFAULT 0 NOT NULL,
        "improvements" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "runs" (
        "id" serial PRIMARY KEY NOT NULL,
        "slate_date" text NOT NULL,
        "sports" jsonb NOT NULL,
        "status" text DEFAULT 'running' NOT NULL,
        "mode" text DEFAULT 'heuristic' NOT NULL,
        "games_found" integer DEFAULT 0 NOT NULL,
        "games_analyzed" integer DEFAULT 0 NOT NULL,
        "games_skipped" integer DEFAULT 0 NOT NULL,
        "trace" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "council" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "completed_at" timestamp with time zone
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "predictions" (
        "id" serial PRIMARY KEY NOT NULL,
        "run_id" integer NOT NULL,
        "sort_order" integer DEFAULT 0 NOT NULL,
        "slate_date" text NOT NULL,
        "sport" text NOT NULL,
        "event_id" text NOT NULL,
        "matchup" text NOT NULL,
        "start_time" timestamp with time zone,
        "category" text NOT NULL,
        "pick" text NOT NULL,
        "line_label" text DEFAULT '' NOT NULL,
        "odds" integer DEFAULT -110 NOT NULL,
        "units" real DEFAULT 1 NOT NULL,
        "confidence" real DEFAULT 56 NOT NULL,
        "edge" real DEFAULT 0 NOT NULL,
        "agents" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "reasoning" text DEFAULT '' NOT NULL,
        "grade" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "outcome" text DEFAULT 'pending' NOT NULL,
        "final_score" text,
        "graded_at" timestamp with time zone,
        CONSTRAINT "predictions_run_id_runs_id_fk"
          FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id")
          ON DELETE cascade ON UPDATE no action
      )
    `);

    // ---- in-place upgrades for databases created by earlier versions ----
    await db.execute(sql`
      ALTER TABLE "agents"      ADD COLUMN IF NOT EXISTS "owner_id"   text NOT NULL DEFAULT 'house';
    `);
    await db.execute(sql`
      ALTER TABLE "agents"      ADD COLUMN IF NOT EXISTS "agent_key"  text NOT NULL DEFAULT '';
    `);
    await db.execute(sql`
      ALTER TABLE "runs"        ADD COLUMN IF NOT EXISTS "owner_id"   text NOT NULL DEFAULT 'house';
    `);
    await db.execute(sql`
      ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "owner_id"   text NOT NULL DEFAULT 'house';
    `);
    await db.execute(sql`
      ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "dedupe_key" text NOT NULL DEFAULT '';
    `);
    // legacy agent rows used the bare key as primary key
    await db.execute(sql`
      UPDATE "agents" SET "agent_key" = "id" WHERE "agent_key" = '';
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS "agents_owner_key_idx"
        ON "agents" ("owner_id", "agent_key");
    `);
    // Hard guarantee: one wager identity per owner can exist only once.
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS "predictions_owner_dedupe_idx"
        ON "predictions" ("owner_id", "dedupe_key")
        WHERE "dedupe_key" <> '';
    `);
    await db.execute(sql`
      ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "markets" jsonb NOT NULL DEFAULT '[]'::jsonb;
    `);
    await db.execute(sql`
      ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "include_events" jsonb NOT NULL DEFAULT '[]'::jsonb;
    `);
    await db.execute(sql`
      ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "is_public" integer NOT NULL DEFAULT 0;
    `);
    await db.execute(sql`
      ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "carried" jsonb NOT NULL DEFAULT '[]'::jsonb;
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "runs_owner_idx" ON "runs" ("owner_id", "id" DESC);
    `);
  })();
  return bootstrapped;
}
