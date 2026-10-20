import {
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
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
  /** Picks the council re-selected that were already live on your ledger. */
  repeats?: { pick: string; matchup: string; firstRunId: number; outcome: string }[];
  /** v5: how selective the council was */
  discipline?: string;
  /** v5: total units the card risks */
  exposure?: number;
  /** v5: candidates evaluated / not released */
  considered?: number;
  passed?: number;
  /** v5: true when the council deliberately released nothing */
  noPlay?: boolean;
}

export type BetCategory =
  | "spread"
  | "total"
  | "moneyline"
  | "team_total"
  | "player_prop"
  | "1h_spread"
  | "1h_total"
  | "1q_total"
  | "p1_total"
  | "f5_total"
  | "nrfi"
  | "fight_ml"
  | "fight_method" // legacy: finish vs decision (kept so old rows still grade)
  | "fight_rounds"
  | "fight_distance"
  | "fight_start_round"
  | "fight_spread"
  | "fight_method_win"
  | "fight_sigstr"
  | "fight_td";

/** Which slice of the game a wager settles against. */
export type Segment = "FULL" | "1H" | "1Q" | "P1" | "F5" | "1I" | "FIGHT";

/**
 * Every MMA market the engine can release, as data. The grader settles a pick
 * purely from this object plus the fight result, so adding a market never
 * requires parsing the human-readable pick text.
 */
export type MmaGrade =
  | { kind: "ml"; fighter: "home" | "away" }
  | { kind: "rounds"; dir: "over" | "under"; line: number }
  | { kind: "distance"; yes: boolean }
  | { kind: "start_round"; round: number; yes: boolean }
  /** finish handicap: -1.5 must win by KO/TKO/sub, +1.5 wins unless finished */
  | { kind: "spread"; fighter: "home" | "away"; line: -1.5 | 1.5 }
  | { kind: "method"; fighter: "home" | "away"; method: "ko" | "sub" | "dec" }
  | { kind: "sigstr"; fighter: "home" | "away"; dir: "over" | "under"; line: number }
  | { kind: "td"; fighter: "home" | "away"; dir: "over" | "under"; line: number };

/** Where to read per-fight statistics from once a bout is final. */
export interface FightRef {
  league: "ufc" | "pfl";
  /** ESPN card (event) id — the prediction's eventId is the bout/competition id */
  cardId: string;
  homeId: string | null;
  awayId: string | null;
}

export interface GradeSpec {
  // resolved against the final score of eventId
  side: "home" | "away" | "over" | "under" | "team_over" | "team_under";
  line: number | null; // spread line for the chosen side / total / team total
  teamAbbr?: string; // for team totals + player props
  player?: string; // player props
  stat?: string; // player prop stat key e.g. PTS, REB, AST, PASS_YDS
  segment?: Segment; // defaults to FULL
  /** combat sports: the market as structured data (see MmaGrade) */
  mma?: MmaGrade;
  fightRef?: FightRef;
}

export const agents = pgTable("agents", {
  // id is `${ownerId}:${agentKey}` for per-visitor rosters
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("house"),
  agentKey: text("agent_key").notNull().default(""),
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
  /** version of the built-in playbook this row was last seeded from */
  promptVersion: integer("prompt_version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const runs = pgTable("runs", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("house"),
  /** true → this run is part of the shared public prediction feed */
  isPublic: integer("is_public").notNull().default(0),
  slateDate: text("slate_date").notNull(), // YYYY-MM-DD
  sports: jsonb("sports").$type<string[]>().notNull(),
  includeEvents: jsonb("include_events")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  markets: jsonb("markets")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  status: text("status").notNull().default("running"), // running | completed | failed
  mode: text("mode").notNull().default("heuristic"), // heuristic | llm
  /** how selective the council is: strict | standard | loose */
  discipline: text("discipline").notNull().default("standard"),
  gamesFound: integer("games_found").notNull().default(0),
  gamesAnalyzed: integer("games_analyzed").notNull().default(0),
  gamesSkipped: integer("games_skipped").notNull().default(0),
  trace: jsonb("trace")
    .$type<TraceEntry[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  /**
   * Prediction ids re-selected by this run that were already staked earlier.
   * They are displayed as part of this run's card but graded only once, on
   * the run that first released them.
   */
  carried: jsonb("carried")
    .$type<number[]>()
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
  ownerId: text("owner_id").notNull().default("house"),
  // stable identity of a wager: same bet twice must never be counted twice
  dedupeKey: text("dedupe_key").notNull().default(""),
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
  /** v5+: the estimated win probability in percent. Older rows: legacy score. */
  confidence: real("confidence").notNull().default(56),
  /** v5+: expected value per unit, in percent. Older rows: legacy score. */
  edge: real("edge").notNull().default(0),
  /** estimated win probability 0..1 (null on pre-v5 rows) */
  modelProb: real("model_prob"),
  /** de-vigged market probability 0..1 when the price came from a sportsbook */
  marketProb: real("market_prob"),
  /** "book" = a posted sportsbook price; "model" = our own fair price */
  priceSource: text("price_source").notNull().default("book"),
  /** model-priced picks: the worst price at which the pick is still a play */
  minPrice: integer("min_price"),
  /** 4 = legacy engine, 5 = market-anchored engine */
  engineVersion: integer("engine_version").notNull().default(4),
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

/**
 * What a person actually bet. Nobody places every pick, and nobody gets the
 * exact suggested price, so the tracker stores the stake and odds the person
 * really used. Settlement flows from the prediction's graded outcome unless
 * the person overrides it (e.g. the book voided the bet or they took a
 * different line).
 */
export const userBets = pgTable(
  "user_bets",
  {
    id: serial("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    predictionId: integer("prediction_id")
      .notNull()
      .references(() => predictions.id, { onDelete: "cascade" }),
    stake: real("stake").notNull(),
    odds: integer("odds").notNull(),
    note: text("note").notNull().default(""),
    /** win | loss | push | void — null means "follow the graded outcome" */
    resultOverride: text("result_override"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_bets_owner_prediction_idx").on(t.ownerId, t.predictionId)],
);

export type AgentRow = typeof agents.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type PredictionRow = typeof predictions.$inferSelect;
export type UserBetRow = typeof userBets.$inferSelect;
