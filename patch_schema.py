import re

p = 'src/db/schema.ts'
s = open(p).read()

# Add agent_key to agents
if 'agent_key' not in s:
    s = s.replace('codename: text("codename").notNull(),', 'agentKey: text("agent_key").notNull().default(""),\n  codename: text("codename").notNull(),')

if 'owner_id' not in s:
    s = s.replace('id: serial("id").primaryKey(),\n  slateDate', 'id: serial("id").primaryKey(),\n  ownerId: text("owner_id").notNull().default("house"),\n  slateDate')
    s = s.replace('id: serial("id").primaryKey(),\n  runId', 'id: serial("id").primaryKey(),\n  ownerId: text("owner_id").notNull().default("house"),\n  dedupeKey: text("dedupe_key").notNull().default(""),\n  runId')

if 'carried: jsonb' not in s:
    s = s.replace('trace: jsonb("trace")', 'markets: jsonb("markets").$type<string[]>().notNull().default(sql`\'[]\'::jsonb`),\n  includeEvents: jsonb("include_events").$type<string[]>().notNull().default(sql`\'[]\'::jsonb`),\n  carried: jsonb("carried").$type<number[]>().notNull().default(sql`\'[]\'::jsonb`),\n  trace: jsonb("trace")')

if 'repeats?:' not in s:
    s = s.replace('avoided: string[];\n}', 'avoided: string[];\n  repeats?: { pick: string; matchup: string; firstRunId: number; outcome: string }[];\n}')

if 'fight_ml' not in s:
    s = s.replace('| "player_prop";', '| "player_prop"\n  | "1h_spread"\n  | "1h_total"\n  | "1q_total"\n  | "p1_total"\n  | "f5_total"\n  | "nrfi"\n  | "fight_ml"\n  | "fight_method"\n  | "fight_rounds";')
    s = s.replace('export interface GradeSpec {', 'export type Segment = "FULL" | "1H" | "1Q" | "P1" | "F5" | "1I" | "FIGHT";\n\nexport interface GradeSpec {')
    s = s.replace('stat?: string; // player prop stat key e.g. PTS, REB, AST, PASS_YDS\n}', 'stat?: string; // player prop stat key e.g. PTS, REB, AST, PASS_YDS\n  segment?: Segment;\n}')

open(p, 'w').write(s)

p = 'src/lib/schema.ts'
s = open(p).read()
if 'agent_key' not in s:
    s = s.replace('})();\n  return bootstrapped;\n}', '''
    await db.execute(sql`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "agent_key" text NOT NULL DEFAULT '';`);
    await db.execute(sql`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "owner_id" text NOT NULL DEFAULT 'house';`);
    await db.execute(sql`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "markets" jsonb NOT NULL DEFAULT '[]'::jsonb;`);
    await db.execute(sql`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "include_events" jsonb NOT NULL DEFAULT '[]'::jsonb;`);
    await db.execute(sql`ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "carried" jsonb NOT NULL DEFAULT '[]'::jsonb;`);
    await db.execute(sql`ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "owner_id" text NOT NULL DEFAULT 'house';`);
    await db.execute(sql`ALTER TABLE "predictions" ADD COLUMN IF NOT EXISTS "dedupe_key" text NOT NULL DEFAULT '';`);
    await db.execute(sql`UPDATE "agents" SET "agent_key" = "id" WHERE "agent_key" = '';`);
  })();
  return bootstrapped;
}''')
open(p, 'w').write(s)
print("Schema patched.")
