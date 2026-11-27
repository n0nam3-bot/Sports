// Client-mirrored API types, kept free of server imports so the bundle stays clean. The one exception is a
// type-only import from lib/forecast (pure, no runtime code) so the Scoreboard's scoring types cannot drift.
import type { Scoreboard } from "@/lib/forecast";

export interface TeamInfoC {
  id: string; abbr: string; name: string; logo: string; color: string;
  record: string; homeRecord: string; awayRecord: string;
}
export interface InjuryC { team: string; player: string; status: string; detail: string }
export interface OddsC {
  provider: string; details: string; homeSpread: number | null;
  homeML: number | null; awayML: number | null; overUnder: number | null;
  overOdds: number | null; underOdds: number | null;
  homeTeamTotal: number | null; awayTeamTotal: number | null;
}
export interface RestC {
  homeDays: number; awayDays: number; homeB2B: boolean; awayB2B: boolean;
  home3in4: boolean; away3in4: boolean; homeTravel: boolean; awayTravel: boolean;
}
export interface ProbableC {
  role: string; name: string; shortName: string; position: string; record: string;
}
export interface GameC {
  eventId: string; sport: string; sportLabel: string; name: string; matchup: string;
  startTime: string; status: "pre" | "in" | "post"; statusDetail: string; venue: string;
  home: TeamInfoC; away: TeamInfoC; odds: OddsC | null; injuries: InjuryC[]; rest: RestC | null;
  context: { homeProbables: ProbableC[]; awayProbables: ProbableC[]; notes: string[]; lineupPosted: boolean };
  combat?: {
    weightClass: string; scheduledRounds: number; titleFight: boolean; cardSegment: string;
    model: {
      pHome: number; pAway: number; fairHomeML: number; fairAwayML: number;
      pFinish: number; fairFinish: number; fairDecision: number;
      expRounds: number; roundLine: number; pRoundsOver: number;
      fairRoundsOver: number; fairRoundsUnder: number;
      statsUsed?: boolean; summary?: string;
    };
    promotion?: string;
    /** "espn" when ESPN published a real moneyline for the bout */
    priceSource?: "espn" | null;
  };
}
export interface SlateResp {
  date: string; sports: string[]; games: GameC[]; providers: string[];
  degraded?: string[];
  counts: { total: number; pre: number; live: number; final: number };
}

export interface TraceC { at: string; layer: string; agent: string; message: string; mood: string }
export interface RepeatC { pick: string; matchup: string; firstRunId: number; outcome: string }
export type Discipline = "strict" | "standard" | "loose";
export interface CouncilC {
  headline: string; memo: string; avoided: string[]; repeats?: RepeatC[];
  discipline?: string; exposure?: number; considered?: number; passed?: number; noPlay?: boolean;
  leans?: number;
  funnel?: {
    games: number; analyzed: number; priced: number;
    gaps: { reason: string; n: number }[];
    candidates: number; plays: number; leans: number;
    /** picks the council still endorses that were already on the ledger (shown, not re-staked) */
    repeats?: number;
    bestEv: number | null; bar: number;
  };
}
export interface PredC {
  id: number; runId: number; sortOrder: number; slateDate: string; sport: string;
  eventId: string; matchup: string; startTime: string | null;
  category: string; pick: string; lineLabel: string; odds: number; units: number;
  /** v5 picks: estimated win probability in percent. Older picks: a legacy score. */
  confidence: number;
  /** v5 picks: expected value per unit in percent. Older picks: a legacy score. */
  edge: number;
  agents: string[]; reasoning: string;
  /** 0..1, null on picks from before the v5 engine */
  modelProb?: number | null;
  marketProb?: number | null;
  /** "book" = a sportsbook's posted price; "model" = our own fair price */
  priceSource?: string;
  /** model-priced picks: the worst price at which the pick is still a play */
  minPrice?: number | null;
  /** 5 = market-anchored engine; 4 = legacy */
  engineVersion?: number;
  outcome: string; finalScore: string | null; gradedAt: string | null;
  carried?: boolean;
  isDuplicate?: boolean;
  canonRunId?: number | null;
  dedupeKey?: string;
}
export interface RunC {
  id: number; slateDate: string; sports: string[]; markets?: string[]; status: string; mode: string;
  discipline?: string;
  isPublic?: number; isViewerRun?: boolean;
  /** GET /api/runs only: the run released at least one NEW pick of its own. Passes and repeat-only runs are false → the Log. */
  productive?: boolean;
  gamesFound: number; gamesAnalyzed: number; gamesSkipped: number;
  trace: TraceC[]; council: CouncilC; carried?: number[]; createdAt: string; completedAt: string | null;
  predictions: PredC[];
}

export interface PubPredC extends PredC {
  isDuplicate?: boolean;
  canonRunId?: number | null;
}

export interface ImprovementC {
  at: string; reason: string; detail: string; ratingBefore: number; ratingAfter: number;
}
export interface AgentC {
  id: string; agentKey?: string; codename: string; layer: string; sortOrder: number; title: string;
  job: string; prompt: string; model: string; rating: number;
  wins: number; losses: number; pushes: number;
  improvements: ImprovementC[]; updatedAt: string;
}

// ---- personal bet tracker ----
export type BetResult = "pending" | "win" | "loss" | "push" | "void";

export interface TrackedPredC {
  id: number; matchup: string; sport: string; category: string; pick: string; lineLabel: string;
  slateDate: string; startTime: string | null;
  /** the council's suggested price / stake */
  odds: number; units: number;
  outcome: string; finalScore: string | null;
  modelProb: number | null; priceSource: string; minPrice: number | null; engineVersion: number;
}
export interface BetC {
  id: number; predictionId: number; stake: number; odds: number; note: string;
  placedAt: string; late: boolean;
  override: Exclude<BetResult, "pending"> | null;
  result: BetResult; pnl: number; evAtPrice: number | null;
  prediction: TrackedPredC;
}
export interface BreakdownC { key: string; bets: number; wins: number; losses: number; staked: number; pnl: number }
export interface BetSummaryC {
  total: number; pending: number; wins: number; losses: number; pushes: number; voids: number;
  staked: number; atRisk: number; pnl: number; roi: number | null; winRate: number | null;
  followAllPnl: number | null; followAllBets: number; vsFollowAll: number | null;
  bySport: BreakdownC[]; byCategory: BreakdownC[];
}

/** A prediction for one game (GET /api/forecasts): our win probability for the side we favour, next to the vig-free market's. NOT a bet. */
export interface ForecastC {
  id: number;
  sport: string;
  eventId: string;
  matchup: string;
  startTime: string;
  pick: string;
  side: "home" | "away";
  /** our P(pick wins), always >= 0.5 */
  pModel: number;
  /** the market's P(pick wins); below 0.5 when it favours the other side; null with no posted moneyline */
  pMarket: number | null;
  note: string;
  /** pending | win | loss | void — win = the PICK won */
  outcome: string;
  finalScore: string | null;
}

/** GET /api/scoreboard — the scoring types come straight from lib/forecast, so they cannot drift from the server. */
export interface ScoreboardC extends Scoreboard {
  asOf: string;
  /** earliest game in the scored window */
  since: string | null;
  /** forecasts still waiting for their game to finish */
  pending: number;
  recent: {
    slateDate: string;
    sport: string;
    matchup: string;
    pick: string;
    pModel: number;
    pMarket: number | null;
    outcome: string;
    finalScore: string | null;
  }[];
}
