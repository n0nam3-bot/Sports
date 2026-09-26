import {
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type AgentLayer = "scout" | "analyst" | "council";

export interface ImprovementEntry {
  at: string;
  reason: string;
  detail: string;
  ratingBefore: number;
  ratingAfter: number;
}

export interface TraceEntry {
  at: string;
  layer: AgentLayer | "system";
  agent: string;
  message: string;
  mood: "info" | "success" | "warn" | "error";
}

export interface CouncilDecision {
  headline: string;
  memo: string;
  avoided: string[];
}

export type BetCategory =
  | "spread"
  | "total"
  | "moneyline"
  | "team_total"
  | "player_prop";

export interface GradeSpec {
  // resolved against the final score of eventId
  side: "home" | "away" | "over" | "under" | "team_over" | "team_under";
  line: number | null; // spread line for the chosen side / total / team total
  teamAbbr?: string; // for team totals + player props
  player?: string; // player props
  stat?: string; // player prop stat key e.g. PTS, REB, AST, PASS_YDS
}

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  codename: text("codename").notNull(),
  layer: text("layer").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  title: text("title").notNull(),
  job: text("job").notNull(),
  prompt: text("prompt").notNull(),
  model: text("model").notNull().default("heuristic-core"),
  rating: real("rating").notNull().default(1500),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  pushes: integer("pushes").notNull().default(0),
  improvements: jsonb("improvements")
    .$type<ImprovementEntry[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const runs = pgTable("runs", {
  id: serial("id").primaryKey(),
  slateDate: text("slate_date").notNull(), // YYYY-MM-DD
  sports: jsonb("sports").$type<string[]>().notNull(),
  status: text("status").notNull().default("running"), // running | completed | failed
  mode: text("mode").notNull().default("heuristic"), // heuristic | llm
  gamesFound: integer("games_found").notNull().default(0),
  gamesAnalyzed: integer("games_analyzed").notNull().default(0),
  gamesSkipped: integer("games_skipped").notNull().default(0),
  trace: jsonb("trace")
    .$type<TraceEntry[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  council: jsonb("council")
    .$type<CouncilDecision>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const predictions = pgTable("predictions", {
  id: serial("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
  slateDate: text("slate_date").notNull(),
  sport: text("sport").notNull(),
  eventId: text("event_id").notNull(),
  matchup: text("matchup").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }),
  category: text("category").notNull(),
  pick: text("pick").notNull(),
  lineLabel: text("line_label").notNull().default(""),
  odds: integer("odds").notNull().default(-110),
  units: real("units").notNull().default(1),
  confidence: real("confidence").notNull().default(56),
  edge: real("edge").notNull().default(0),
  agents: jsonb("agents")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  reasoning: text("reasoning").notNull().default(""),
  grade: jsonb("grade")
    .$type<GradeSpec>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  outcome: text("outcome").notNull().default("pending"), // win | loss | push | void | pending
  finalScore: text("final_score"),
  gradedAt: timestamp("graded_at", { withTimezone: true }),
});

export type AgentRow = typeof agents.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type PredictionRow = typeof predictions.$inferSelect;
