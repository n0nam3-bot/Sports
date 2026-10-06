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
  group: "core" | "props" | "segments" | "combat";
}

export const MIXED = "mixed";

export const MARKET_OPTIONS: MarketOption[] = [
  // ---- core ----
  {
    id: "spread",
    label: "Spreads",
    hint: "point spread / run line / puck line",
    categories: ["spread"],
    group: "core",
  },
  {
    id: "moneyline",
    label: "Moneyline",
    hint: "straight-up winners",
    categories: ["moneyline"],
    group: "core",
  },
  {
    id: "game_total",
    label: "Game Totals",
    hint: "over / under the full-game number",
    categories: ["total"],
    group: "core",
  },
  {
    id: "team_total",
    label: "Team Totals",
    hint: "one side's scoring number",
    categories: ["team_total"],
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
    label: "F5 & NRFI",
    hint: "first five innings, no-run first inning",
    categories: ["f5_total", "nrfi"],
    sports: ["mlb"],
    group: "segments",
  },
  // ---- combat ----
  {
    id: "fight_winner",
    label: "Fight Winner",
    hint: "moneyline on the bout",
    categories: ["fight_ml"],
    sports: ["ufc", "dwcs", "pfl"],
    group: "combat",
  },
  {
    id: "fight_method",
    label: "Method of Victory",
    hint: "finish vs decision",
    categories: ["fight_method"],
    sports: ["ufc", "dwcs", "pfl"],
    group: "combat",
  },
  {
    id: "fight_rounds",
    label: "Round Totals",
    hint: "over / under scheduled rounds",
    categories: ["fight_rounds"],
    sports: ["ufc", "dwcs", "pfl"],
    group: "combat",
  },
];

export const ALL_MARKET_IDS = MARKET_OPTIONS.map((m) => m.id);

export interface MarketFilter {
  mixed: boolean;
  categories: Set<string>;
  stats: Set<string> | null; // null = any stat allowed
}

export function buildFilter(selected: string[] | undefined): MarketFilter {
  const list = (selected ?? []).filter((id) => id !== MIXED);
  if (!list.length) {
    return { mixed: true, categories: new Set(), stats: null };
  }
  const categories = new Set<string>();
  const stats = new Set<string>();
  let anyStatOption = false;
  for (const id of list) {
    const opt = MARKET_OPTIONS.find((m) => m.id === id);
    if (!opt) continue;
    for (const c of opt.categories) categories.add(c);
    if (opt.stats) {
      anyStatOption = true;
      for (const st of opt.stats) stats.add(st);
    }
  }
  return {
    mixed: false,
    categories,
    stats: anyStatOption ? stats : null,
  };
}

/** Does a produced candidate satisfy the user's market preference? */
export function allowsCandidate(
  f: MarketFilter,
  category: string,
  stat?: string,
): boolean {
  if (f.mixed) return true;
  if (!f.categories.has(category)) return false;
  // player props additionally honour the stat-level choice
  if (category === "player_prop" && f.stats) {
    return !!stat && f.stats.has(stat);
  }
  return true;
}

/** Options relevant to the sports currently selected. */
export function optionsForSports(sports: string[]): MarketOption[] {
  return MARKET_OPTIONS.filter(
    (m) => !m.sports || m.sports.some((s) => sports.includes(s)),
  );
}
