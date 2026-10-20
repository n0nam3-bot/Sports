/**
 * Market preference catalogue.
 *
 * "mixed" (default) lets the council build a balanced card. Selecting specific
 * markets narrows the cluster to exactly what the user wants to bet — e.g.
 * NFL + only rushing yards, or UFC + only method-of-victory props.
 */

export interface MarketOption {
  id: string;
  label: string;
  hint: string;
  /** bet categories this option unlocks */
  categories: string[];
  /** when set, only player props with these stat keys qualify */
  stats?: string[];
  /** limits the option to certain sports (empty = all) */
  sports?: string[];
  /**
   * combat only: fine-grained market keys this option unlocks (see
   * `mmaMarketKey`). Lets "Over/Under 1.5" and "Starts Rd 3" be picked
   * individually rather than as one lump.
   */
  keys?: string[];
  /** combat only: sub-heading the option is shown under */
  sub?: string;
  group: "core" | "props" | "segments" | "combat";
}

export const MIXED = "mixed";

const COMBAT = ["ufc", "dwcs", "pfl"];
const TEAM = ["nba", "nfl", "ncaaf", "ncaab", "mlb", "nhl"];

export const MARKET_OPTIONS: MarketOption[] = [
  // ---- core ----
  {
    id: "spread",
    label: "Spreads",
    hint: "point spread / run line / puck line",
    categories: ["spread"],
    sports: TEAM,
    group: "core",
  },
  {
    id: "moneyline",
    label: "Moneyline",
    hint: "straight-up winners",
    categories: ["moneyline"],
    sports: TEAM,
    group: "core",
  },
  {
    id: "game_total",
    label: "Game Totals",
    hint: "over / under the full-game number",
    categories: ["total"],
    sports: TEAM,
    group: "core",
  },
  {
    id: "team_total",
    label: "Team Totals",
    hint: "one side's scoring number",
    categories: ["team_total"],
    sports: TEAM,
    group: "core",
  },
  // ---- player props ----
  {
    id: "prop_pass_yds",
    label: "Passing Yards",
    hint: "QB yardage overs / unders",
    categories: ["player_prop"],
    stats: ["PASS_YDS"],
    sports: ["nfl", "ncaaf"],
    group: "props",
  },
  {
    id: "prop_rush_yds",
    label: "Rushing Yards",
    hint: "RB / QB ground yardage",
    categories: ["player_prop"],
    stats: ["RUSH_YDS"],
    sports: ["nfl", "ncaaf"],
    group: "props",
  },
  {
    id: "prop_rec_yds",
    label: "Receiving Yards",
    hint: "WR / TE yardage",
    categories: ["player_prop"],
    stats: ["REC_YDS"],
    sports: ["nfl", "ncaaf"],
    group: "props",
  },
  {
    id: "prop_td",
    label: "Touchdowns",
    hint: "anytime TD & passing TD props",
    categories: ["player_prop"],
    stats: ["ANY_TD", "PASS_TD"],
    sports: ["nfl", "ncaaf"],
    group: "props",
  },
  {
    id: "prop_points",
    label: "Points",
    hint: "scoring props",
    categories: ["player_prop"],
    stats: ["PTS"],
    sports: ["nba", "ncaab"],
    group: "props",
  },
  {
    id: "prop_reb_ast",
    label: "Rebounds & Assists",
    hint: "boards and dimes",
    categories: ["player_prop"],
    stats: ["REB", "AST"],
    sports: ["nba", "ncaab"],
    group: "props",
  },
  {
    id: "prop_skater",
    label: "Goals & Shots",
    hint: "skater props",
    categories: ["player_prop"],
    stats: ["GOALS", "SHOTS"],
    sports: ["nhl"],
    group: "props",
  },
    {
    id: "prop_mlb_hits",
    label: "Hits",
    hint: "Batter hits",
    categories: ["player_prop"],
    stats: ["HITS"],
    sports: ["mlb"],
    group: "props",
  },
  {
    id: "prop_mlb_walks",
    label: "Walks",
    hint: "Batter walks",
    categories: ["player_prop"],
    stats: ["WALKS"],
    sports: ["mlb"],
    group: "props",
  },
  {
    id: "prop_mlb_bases",
    label: "Total Bases",
    hint: "Batter total bases",
    categories: ["player_prop"],
    stats: ["TOTAL_BASES"],
    sports: ["mlb"],
    group: "props",
  },
  {
    id: "prop_mlb_hr",
    label: "Home Runs",
    hint: "Batter home runs",
    categories: ["player_prop"],
    stats: ["HOME_RUNS"],
    sports: ["mlb"],
    group: "props",
  },
  {
    id: "prop_pitcher_k",
    label: "Pitcher Strikeouts",
    hint: "Pitcher Ks",
    categories: ["player_prop"],
    stats: ["PITCHER_K"],
    sports: ["mlb"],
    group: "props",
  },
  {
    id: "prop_pitcher_outs",
    label: "Pitcher Outs",
    hint: "Pitcher outs recorded",
    categories: ["player_prop"],
    stats: ["PITCHER_OUTS"],
    sports: ["mlb"],
    group: "props",
  },
  // ---- segments ----
  {
    id: "first_half",
    label: "1st Half",
    hint: "halftime spreads & totals",
    categories: ["1h_spread", "1h_total"],
    sports: ["nfl", "ncaaf", "nba", "ncaab"],
    group: "segments",
  },
  {
    id: "first_quarter",
    label: "1st Quarter / Period",
    hint: "opening-frame totals",
    categories: ["1q_total", "p1_total"],
    sports: ["nfl", "ncaaf", "nba", "nhl"],
    group: "segments",
  },
  {
    id: "innings",
    label: "First 5 Innings",
    // NRFI/YRFI is no longer produced: the old Poisson model was miscalibrated and there is
    // no free data to price it. Old NRFI rows still grade.
    hint: "first-five-innings total (model line)",
    categories: ["f5_total"],
    sports: ["mlb"],
    group: "segments",
  },
  // ---- combat ----
  // Fight result
  {
    id: "fight_winner",
    label: "Moneyline",
    hint: "who wins the fight",
    categories: ["fight_ml"],
    keys: ["ml"],
    sports: COMBAT,
    group: "combat",
    sub: "Fight result",
  },
  {
    id: "fight_spread",
    label: "Point Spread",
    hint: "finish handicap: -1.5 must win by KO/sub, +1.5 wins unless finished",
    categories: ["fight_spread"],
    keys: ["spread"],
    sports: COMBAT,
    group: "combat",
    sub: "Fight result",
  },
  // Total rounds
  ...[0.5, 1.5, 2.5, 3.5, 4.5].map(
    (L): MarketOption => ({
      id: `rounds_${String(L).replace(".", "_")}`,
      label: `Over / Under ${L}`,
      hint: L >= 3 ? "only on 5-round fights" : "rounds fought",
      categories: ["fight_rounds"],
      keys: [`rounds_${L}`],
      sports: COMBAT,
      group: "combat",
      sub: "Total rounds",
    }),
  ),
  {
    id: "fight_distance_yes",
    label: "Goes the distance",
    hint: "fight does go the full distance",
    categories: ["fight_distance"],
    keys: ["distance_yes"],
    sports: COMBAT,
    group: "combat",
    sub: "Total rounds",
  },
  {
    id: "fight_distance_no",
    label: "Doesn't go the distance",
    hint: "fight ends inside the distance",
    categories: ["fight_distance"],
    keys: ["distance_no"],
    sports: COMBAT,
    group: "combat",
    sub: "Total rounds",
  },
  ...[2, 3, 4, 5].map(
    (k): MarketOption => ({
      id: `fight_start_${k}`,
      label: `Starts Round ${k}`,
      hint: k > 3 ? "yes / no · 5-round fights only" : "yes / no",
      categories: ["fight_start_round"],
      keys: [`start_${k}`],
      sports: COMBAT,
      group: "combat",
      sub: "Total rounds",
    }),
  ),
  // Winning method
  {
    id: "method_dec",
    label: "Decision",
    hint: "a named fighter wins on the scorecards",
    categories: ["fight_method_win"],
    keys: ["method_dec"],
    sports: COMBAT,
    group: "combat",
    sub: "Winning method",
  },
  {
    id: "method_sub",
    label: "Submission",
    hint: "a named fighter wins by submission",
    categories: ["fight_method_win"],
    keys: ["method_sub"],
    sports: COMBAT,
    group: "combat",
    sub: "Winning method",
  },
  {
    id: "method_ko",
    label: "KO / TKO",
    hint: "a named fighter wins by knockout",
    categories: ["fight_method_win"],
    keys: ["method_ko"],
    sports: COMBAT,
    group: "combat",
    sub: "Winning method",
  },
  // Volume props
  {
    id: "fight_sigstr",
    label: "Sig. Strikes Landed",
    hint: "over / under per fighter",
    categories: ["fight_sigstr"],
    keys: ["sigstr"],
    sports: COMBAT,
    group: "combat",
    sub: "Fighter props",
  },
  {
    id: "fight_td",
    label: "Takedowns Landed",
    hint: "over / under per fighter",
    categories: ["fight_td"],
    keys: ["td"],
    sports: COMBAT,
    group: "combat",
    sub: "Fighter props",
  },
];

/**
 * Saved selections from before the MMA catalogue was split up. They expand to
 * the equivalent granular options so returning users don't lose their picks.
 */
const LEGACY_ALIASES: Record<string, string[]> = {
  fight_rounds: ["rounds_0_5", "rounds_1_5", "rounds_2_5", "rounds_3_5", "rounds_4_5"],
  fight_method: ["fight_distance_yes", "fight_distance_no"],
};

export const ALL_MARKET_IDS = MARKET_OPTIONS.map((m) => m.id);

export interface MarketFilter {
  mixed: boolean;
  categories: Set<string>;
  stats: Set<string> | null; // null = any stat allowed
  /** combat: allowed fine-grained keys; null = every key in an allowed category */
  keys: Set<string> | null;
}

/** Every combat bet category (MMA has no sportsbook feed, so all are model-priced). */
export const COMBAT_CATEGORIES = new Set([
  "fight_ml",
  "fight_method",
  "fight_rounds",
  "fight_distance",
  "fight_start_round",
  "fight_spread",
  "fight_method_win",
  "fight_sigstr",
  "fight_td",
]);

/**
 * In "mixed" mode the council only releases markets that have a REAL posted
 * price (spread / moneyline / game total) plus MMA. Derived markets — team
 * totals, halves, quarters, F5/NRFI, player props — have no sportsbook line in
 * our free feed, so their numbers are our own. They are available, but only
 * when you ask for them explicitly.
 */
export const MIXED_CATEGORIES = new Set(["spread", "moneyline", "total", ...COMBAT_CATEGORIES]);

export function buildFilter(selected: string[] | undefined): MarketFilter {
  const expanded = (selected ?? [])
    .filter((id) => id !== MIXED)
    .flatMap((id) => LEGACY_ALIASES[id] ?? [id]);
  const categories = new Set<string>();
  const stats = new Set<string>();
  const keys = new Set<string>();
  let anyStatOption = false;
  let anyKeyOption = false;
  let matched = 0;
  for (const id of expanded) {
    const opt = MARKET_OPTIONS.find((m) => m.id === id);
    if (!opt) continue;
    matched++;
    for (const c of opt.categories) categories.add(c);
    if (opt.stats) {
      anyStatOption = true;
      for (const st of opt.stats) stats.add(st);
    }
    if (opt.keys) {
      anyKeyOption = true;
      for (const k of opt.keys) keys.add(k);
    }
  }
  // An unrecognised/empty selection must never silently block every pick.
  if (!matched) return { mixed: true, categories: new Set(), stats: null, keys: null };
  return {
    mixed: false,
    categories,
    stats: anyStatOption ? stats : null,
    keys: anyKeyOption ? keys : null,
  };
}

/** Does a produced candidate satisfy the user's market preference? */
export function allowsCandidate(
  f: MarketFilter,
  category: string,
  stat?: string,
  key?: string,
): boolean {
  if (f.mixed) return MIXED_CATEGORIES.has(category);
  if (!f.categories.has(category)) return false;
  // player props additionally honour the stat-level choice
  if (category === "player_prop" && f.stats) {
    return !!stat && f.stats.has(stat);
  }
  // combat markets honour the fine-grained choice (e.g. only the 1.5 line)
  if (COMBAT_CATEGORIES.has(category) && f.keys && key) {
    return f.keys.has(key);
  }
  return true;
}

/**
 * The fine-grained key of an MMA market, matching `MarketOption.keys`.
 * Total-rounds and start-round markets are keyed by line / round only, so one
 * chip covers both the over and the under (or the yes and the no).
 */
export function mmaMarketKey(m: import("../db/schema").MmaGrade): string {
  switch (m.kind) {
    case "ml":
      return "ml";
    case "spread":
      return "spread";
    case "rounds":
      return `rounds_${m.line}`;
    case "distance":
      return m.yes ? "distance_yes" : "distance_no";
    case "start_round":
      return `start_${m.round}`;
    case "method":
      return `method_${m.method}`;
    case "sigstr":
      return "sigstr";
    case "td":
      return "td";
  }
}

/** Options relevant to the sports currently selected. */
export function optionsForSports(sports: string[]): MarketOption[] {
  return MARKET_OPTIONS.filter(
    (m) => !m.sports || m.sports.some((s) => sports.includes(s)),
  );
}
