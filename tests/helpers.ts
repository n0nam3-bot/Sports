import type { GameInfo, OddsInfo, TeamInfo } from "../src/lib/espn";
import { buildEnhancedCombatModel, type FighterProfile } from "../src/lib/fighter-stats";
import type { Promotion } from "../src/lib/mma-model";

export function team(abbr: string, over: Partial<TeamInfo> = {}): TeamInfo {
  return {
    id: abbr,
    abbr,
    name: `${abbr} Team`,
    logo: "",
    color: "#222",
    record: "20-20",
    homeRecord: "10-10",
    awayRecord: "10-10",
    ...over,
  };
}

export function odds(over: Partial<OddsInfo> = {}): OddsInfo {
  return {
    provider: "test",
    details: "",
    homeSpread: -3.5,
    homeSpreadOdds: -110,
    awaySpreadOdds: -110,
    homeML: -170,
    awayML: 145,
    overUnder: 220.5,
    overOdds: -110,
    underOdds: -110,
    homeTeamTotal: 112,
    awayTeamTotal: 108.5,
    teamTotalsDerived: true,
    ...over,
  };
}

let seq = 1000;

export function teamGame(over: Partial<GameInfo> = {}): GameInfo {
  const id = String(seq++);
  const home = over.home ?? team("BOS");
  const away = over.away ?? team("NYK");
  return {
    eventId: id,
    sport: "nba",
    sportLabel: "NBA",
    name: `${away.name} at ${home.name}`,
    matchup: `${away.abbr} @ ${home.abbr}`,
    startTime: new Date(Date.now() + 3 * 3600_000).toISOString(),
    status: "pre",
    statusDetail: "",
    venue: "",
    home,
    away,
    odds: odds(),
    injuries: [],
    rest: null,
    leaders: [],
    context: {
      homeProbables: [],
      awayProbables: [],
      notes: [],
      lineupPosted: false,
      injuriesChecked: true,
      predictor: null,
    },
    ...over,
  };
}

export function profile(over: Partial<FighterProfile> = {}): FighterProfile {
  return {
    athleteId: "1",
    displayName: "Fighter",
    hasStats: true,
    reach: 72,
    height: 70,
    stance: "Orthodox",
    strikeLPM: 3.4,
    strikeAccuracy: 45,
    strikeDefense: 55,
    takedownAvg: 0.9,
    takedownAccuracy: 40,
    takedownDefense: 62,
    submissionAvg: 0.5,
    koTkoPct: 35,
    decisionPct: 30,
    finishRate: 0.5,
    ...over,
  };
}

export interface BoutOpts {
  rounds?: number;
  weightClass?: string;
  promotion?: Promotion;
  awayRecord?: string;
  homeRecord?: string;
  away?: FighterProfile | null;
  home?: FighterProfile | null;
  odds?: OddsInfo | null;
  sport?: string;
}

export function bout(o: BoutOpts = {}): GameInfo {
  const rounds = o.rounds ?? 3;
  const weightClass = o.weightClass ?? "Lightweight";
  const promotion = o.promotion ?? "ufc";
  const awayRecord = o.awayRecord ?? "15-4-0";
  const homeRecord = o.homeRecord ?? "15-4-0";
  const away = "away" in o ? o.away! : profile({ athleteId: "A1", displayName: "Away Fighter" });
  const home = "home" in o ? o.home! : profile({ athleteId: "H1", displayName: "Home Fighter" });
  const enhanced = buildEnhancedCombatModel(awayRecord, homeRecord, weightClass, rounds, away, home, promotion);
  const a = team("AWAY", { name: "Away Fighter", record: awayRecord, id: "A1" });
  const h = team("HOME", { name: "Home Fighter", record: homeRecord, id: "H1" });
  return {
    eventId: String(seq++),
    sport: o.sport ?? "ufc",
    sportLabel: "UFC",
    name: "Away Fighter vs Home Fighter",
    matchup: "AWAY vs HOME",
    startTime: new Date(Date.now() + 5 * 3600_000).toISOString(),
    status: "pre",
    statusDetail: "",
    venue: "",
    home: h,
    away: a,
    odds: o.odds ?? null,
    injuries: [],
    rest: null,
    leaders: [],
    context: { homeProbables: [], awayProbables: [], notes: [], lineupPosted: false },
    combat: {
      weightClass,
      scheduledRounds: rounds,
      titleFight: rounds === 5,
      cardSegment: rounds === 5 ? "Main Card" : "Undercard",
      model: enhanced,
      dist: enhanced.dist,
      promotion,
      eventId: "CARD1",
      competitionId: "BOUT1",
      league: promotion === "pfl" ? "pfl" : "ufc",
      fighterIds: { away: "A1", home: "H1" },
      priceSource: null,
    },
  };
}

export const idGen = (): (() => number) => {
  let n = 0;
  return () => ++n;
};
