// Client-mirrored API types (kept schema-import-free so the bundle stays clean).

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
export interface GameC {
  eventId: string; sport: string; sportLabel: string; name: string; matchup: string;
  startTime: string; status: "pre" | "in" | "post"; statusDetail: string; venue: string;
  home: TeamInfoC; away: TeamInfoC; odds: OddsC | null; injuries: InjuryC[]; rest: RestC | null;
  combat?: {
    weightClass: string; scheduledRounds: number; titleFight: boolean; cardSegment: string;
    model: {
      pHome: number; pAway: number; fairHomeML: number; fairAwayML: number;
      pFinish: number; fairFinish: number; fairDecision: number;
      expRounds: number; roundLine: number; pRoundsOver: number;
      fairRoundsOver: number; fairRoundsUnder: number;
    };
  };
}
export interface SlateResp {
  date: string; sports: string[]; games: GameC[]; providers: string[];
  degraded?: string[];
  counts: { total: number; pre: number; live: number; final: number };
}

export interface TraceC { at: string; layer: string; agent: string; message: string; mood: string }
export interface RepeatC { pick: string; matchup: string; firstRunId: number; outcome: string }
export interface CouncilC { headline: string; memo: string; avoided: string[]; repeats?: RepeatC[] }
export interface PredC {
  id: number; runId: number; sortOrder: number; slateDate: string; sport: string;
  eventId: string; matchup: string; startTime: string | null;
  category: string; pick: string; lineLabel: string; odds: number; units: number;
  confidence: number; edge: number; agents: string[]; reasoning: string;
  outcome: string; finalScore: string | null; gradedAt: string | null;
  carried?: boolean;
}
export interface RunC {
  id: number; slateDate: string; sports: string[]; markets?: string[]; status: string; mode: string;
  gamesFound: number; gamesAnalyzed: number; gamesSkipped: number;
  trace: TraceC[]; council: CouncilC; carried?: number[]; createdAt: string; completedAt: string | null;
  predictions: PredC[];
}

export interface ImprovementC {
  at: string; reason: string; detail: string; ratingBefore: number; ratingAfter: number;
}
export interface AgentC {
  id: string; codename: string; layer: string; sortOrder: number; title: string;
  job: string; prompt: string; model: string; rating: number;
  wins: number; losses: number; pushes: number;
  improvements: ImprovementC[]; updatedAt: string;
}
