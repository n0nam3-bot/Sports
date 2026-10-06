/**
 * Real UFC/MMA fighter statistics from ESPN's core API.
 * Returns career metrics: striking rate, accuracy, TD rate, finish percentages.
 * Reach and stance are also fetched for the style-matchup model.
 * This is a distinct API host (sports.core.api.espn.com) that carries
 * much richer data than the public scoreboard endpoint.
 */

const CORE = "https://sports.core.api.espn.com/v2/sports/mma";

export interface FighterProfile {
  displayName: string;
  reach: number | null;     // inches
  height: number | null;    // inches
  stance: string;           // "Orthodox" | "Southpaw" | "Switch" | "Unknown"
  // career per-minute & percentage stats
  strikeLPM: number;        // significant strikes landed per minute
  strikeAccuracy: number;   // 0-100
  strikeDefense: number;    // 0-100 (absorbed / attempted against)
  takedownAvg: number;      // per 15 min
  takedownAccuracy: number; // 0-100
  takedownDefense: number;  // 0-100
  submissionAvg: number;    // per 15 min
  koTkoPct: number;         // KO + TKO finish %
  decisionPct: number;      // decision win %
  // derived finish tendency
  finishRate: number;       // probability fight ends inside distance (0-1)
}

async function jfetch(url: string, timeoutMs = 6000): Promise<any | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { "user-agent": "okhttp/4.12.0", accept: "application/json" },
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function readStats(categories: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cat of categories) {
    for (const s of cat?.stats ?? []) {
      const name: string = s?.name ?? "";
      const val = parseFloat(s?.value ?? s?.displayValue ?? "0");
      if (name && Number.isFinite(val)) out[name] = val;
    }
  }
  return out;
}

/** Fetch a fighter profile given their ESPN athlete ID. */
export async function fetchFighterProfile(
  athleteId: string,
): Promise<FighterProfile | null> {
  const [ath, statsData] = await Promise.all([
    jfetch(`${CORE}/athletes/${athleteId}?lang=en&region=us`),
    jfetch(`${CORE}/athletes/${athleteId}/statistics?lang=en&region=us`),
  ]);
  if (!ath) return null;

  const stance =
    typeof ath.stance === "string"
      ? ath.stance
      : (ath.stance as any)?.text ?? "Unknown";

  const cats: any[] = statsData?.splits?.categories ?? [];
  const s = readStats(cats);

  const koTkoPct = (s["koPercentage"] ?? 0) + (s["tkoPercentage"] ?? 0);
  const decPct = s["decisionPercentage"] ?? 33;
  // Infer finish rate from decision percentage: (100 - decision%) = finish%.
  // ESPN's decisionPercentage counts only decision WINS as a % of total fights,
  // so a 22% decision rate means ~78% of wins ended by finish — but total
  // fights includes losses, so we need to be conservative.
  // Use: finishRate ≈ 1 - min(decPct/50, 0.80) — caps so pure decisions aren't 100%
  const impliedFinish = 1 - Math.min(decPct / 50, 0.80);
  const explicitFinish = koTkoPct / 100 + (s["submissionAvg"] ?? 0) * 0.25;
  // Blend: use explicit when we have KO/sub data, fallback to implied from dec%
  const finishRate = Math.min(0.82, Math.max(0.18,
    koTkoPct > 0 || (s["submissionAvg"] ?? 0) > 0.5
      ? Math.max(impliedFinish, explicitFinish)
      : impliedFinish,
  ));

  return {
    displayName: ath.displayName ?? ath.fullName ?? "Unknown",
    reach: typeof ath.reach === "number" ? ath.reach : null,
    height: typeof ath.height === "number" ? ath.height : null,
    stance,
    strikeLPM: s["strikeLPM"] ?? 2.5,
    strikeAccuracy: s["strikeAccuracy"] ?? 40,
    strikeDefense: s["strikeDefense"] ?? 55,
    takedownAvg: s["takedownAvg"] ?? 1,
    takedownAccuracy: s["takedownAccuracy"] ?? 35,
    takedownDefense: s["takedownDefense"] ?? 60,
    submissionAvg: s["submissionAvg"] ?? 0.3,
    koTkoPct,
    decisionPct: decPct,
    finishRate,
  };
}

/**
 * Pull both fighters' profiles from the competitor list in an upcoming bout.
 * ESPN nests athlete IDs inside the competition's competitor refs.
 */
export async function fetchBoutProfiles(
  eventId: string,
  competitionId: string,
  league: "ufc" | "pfl",
): Promise<{ away: FighterProfile | null; home: FighterProfile | null }> {
  const base = `${CORE}/leagues/${league}/events/${eventId}/competitions/${competitionId}/competitors`;
  const compList = await jfetch(`${base}?lang=en&region=us`);
  if (!compList?.items?.length) return { away: null, home: null };

  const profiles: (FighterProfile | null)[] = [];
  for (const item of compList.items.slice(0, 2)) {
    const ref: string | undefined = typeof item === "string" ? item : item?.$ref;
    if (!ref) { profiles.push(null); continue; }
    const comp = await jfetch(ref);
    const athRef: string | undefined = comp?.athlete?.$ref;
    if (!athRef) { profiles.push(null); continue; }
    const athId = athRef.match(/athletes\/(\d+)/)?.[1];
    if (!athId) { profiles.push(null); continue; }
    profiles.push(await fetchFighterProfile(athId));
  }

  return { away: profiles[0] ?? null, home: profiles[1] ?? null };
}

/**
 * Enhanced combat model using real ESPN stats.
 * Falls back to record-only model when stats are unavailable.
 */
export interface EnhancedCombatModel {
  pace: string;
  cardio: string;
  pHome: number;
  pAway: number;
  fairHomeML: number;
  fairAwayML: number;
  pFinish: number;
  fairFinish: number;
  fairDecision: number;
  expRounds: number;
  roundLine: number;
  pRoundsOver: number;
  fairRoundsOver: number;
  fairRoundsUnder: number;
  statsUsed: boolean;
  summary: string; // human-readable matchup summary for agents
}

function american(p: number): number {
  const c = Math.min(0.93, Math.max(0.07, p));
  return c >= 0.5 ? -Math.round((c / (1 - c)) * 100) : Math.round(((1 - c) / c) * 100);
}

function winPctFromRecord(rec: string): { pct: number; fights: number } {
  const m = rec.match(/(\d+)\D+(\d+)(?:\D+(\d+))?/);
  if (!m) return { pct: 0.5, fights: 0 };
  const w = Number(m[1]); const l = Number(m[2]); const d = Number(m[3] ?? 0);
  const f = w + l + d;
  return { pct: f > 0 ? (w + 0.5 * d) / f : 0.5, fights: f };
}

export function buildEnhancedCombatModel(
  awayRecord: string,
  homeRecord: string,
  weightClass: string,
  scheduledRounds: number,
  awayProfile: FighterProfile | null,
  homeProfile: FighterProfile | null,
): EnhancedCombatModel {
  const awayRec = winPctFromRecord(awayRecord);
  const homeRec = winPctFromRecord(homeRecord);

  let pHome: number;
  let pFinish: number;
  let summaryLines: string[] = [];
  const statsUsed = !!(awayProfile && homeProfile);

  const heavy = /heavy|light heavy|middle/i.test(weightClass);
  const light = /straw|fly|bantam|feather/i.test(weightClass);

  if (statsUsed && awayProfile && homeProfile) {
    // ---- Striking edge ----
    // If A's strike rate × accuracy > B's defense, A has a striking advantage.
    const aStrk = (awayProfile.strikeLPM * awayProfile.strikeAccuracy) / 100;
    const hStrk = (homeProfile.strikeLPM * homeProfile.strikeAccuracy) / 100;
    const strkEdge = (aStrk - hStrk) / Math.max(1, aStrk + hStrk); // normalised -1..+1

    // ---- Grappling edge ----
    const aTD  = awayProfile.takedownAvg * (awayProfile.takedownAccuracy / 100);
    const hTD  = homeProfile.takedownAvg * (homeProfile.takedownAccuracy / 100);
    const tdEdge = (aTD - hTD) / Math.max(0.5, aTD + hTD);

    // ---- Record momentum ----
    const recDiff = awayRec.pct - homeRec.pct;

    // Composite win probability for away fighter. Weights: record 35%, striking 35%, TD 20%, exp 10%
    const expEdge = (awayRec.fights - homeRec.fights) * 0.004;
    const rawPAway = 0.5 + recDiff * 0.35 + strkEdge * 0.35 + tdEdge * 0.20 + expEdge;
    const pAway = Math.min(0.88, Math.max(0.12, rawPAway));
    pHome = 1 - pAway;

    // ---- Finish probability ----
    const avgFinish = (awayProfile.finishRate + homeProfile.finishRate) / 2;
    pFinish = Math.min(0.82, Math.max(0.18,
      avgFinish
        + (heavy ? 0.08 : 0)
        - (light ? 0.06 : 0)
        - (scheduledRounds === 5 ? 0.05 : 0),
    ));

    // ---- Style summary ----
    const stanceNote = awayProfile.stance === homeProfile.stance
      ? `both ${awayProfile.stance.toLowerCase()}`
      : `${awayProfile.stance.toLowerCase()} vs ${homeProfile.stance.toLowerCase()}`;
    const reachNote = awayProfile.reach && homeProfile.reach
      ? `reach ${awayProfile.reach}" vs ${homeProfile.reach}"`
      : "";
    const strNote = strkEdge > 0.05
      ? `${awayProfile.displayName} has the striking edge (${awayProfile.strikeLPM.toFixed(1)} SLpM at ${awayProfile.strikeAccuracy.toFixed(0)}% acc vs ${homeProfile.strikeLPM.toFixed(1)} SLpM at ${homeProfile.strikeAccuracy.toFixed(0)}% acc)`
      : strkEdge < -0.05
        ? `${homeProfile.displayName} is the sharper striker (${homeProfile.strikeLPM.toFixed(1)} SLpM at ${homeProfile.strikeAccuracy.toFixed(0)}% acc vs ${awayProfile.strikeLPM.toFixed(1)} SLpM at ${awayProfile.strikeAccuracy.toFixed(0)}% acc)`
        : `striking output is similar (${awayProfile.strikeLPM.toFixed(1)} vs ${homeProfile.strikeLPM.toFixed(1)} SLpM)`;
    const tdNote = aTD > 0.1 || hTD > 0.1
      ? tdEdge > 0.1
        ? `${awayProfile.displayName} leans on grappling (${awayProfile.takedownAvg.toFixed(1)} TDs per 15min at ${awayProfile.takedownAccuracy.toFixed(0)}% acc${hTD > 0 ? ` vs ${homeProfile.takedownAvg.toFixed(1)} at ${homeProfile.takedownAccuracy.toFixed(0)}%` : ", opponent shows no TD game"})`
        : tdEdge < -0.1
          ? `${homeProfile.displayName} brings the takedown pressure (${homeProfile.takedownAvg.toFixed(1)} TDs per 15min at ${homeProfile.takedownAccuracy.toFixed(0)}% acc${aTD > 0 ? ` vs ${awayProfile.takedownAvg.toFixed(1)} at ${awayProfile.takedownAccuracy.toFixed(0)}%` : ", opponent shows no TD game"})`
          : `both work takedowns (${awayProfile.takedownAvg.toFixed(1)} vs ${homeProfile.takedownAvg.toFixed(1)} per 15min)`
      : "neither fighter shows significant wrestling volume";

    // Pace & Cardio evaluation
    const combinedSLpM = awayProfile.strikeLPM + homeProfile.strikeLPM;
    const pace = combinedSLpM > 9 ? "High pace" : combinedSLpM > 6.5 ? "Moderate pace" : "Slow pace";
    const cardioA = awayProfile.decisionPct > 40 ? "proven" : awayProfile.decisionPct < 15 ? "suspect" : "average";
    const cardioH = homeProfile.decisionPct > 40 ? "proven" : homeProfile.decisionPct < 15 ? "suspect" : "average";
    const cardio = `${awayProfile.displayName} cardio is ${cardioA}, ${homeProfile.displayName} is ${cardioH}`;

    summaryLines = [
      `${weightClass}${scheduledRounds === 5 ? " · 5-round" : ""}`,
      stanceNote + (reachNote ? ` · ${reachNote}` : ""),
      strNote,
      tdNote,
      `${pace}. ${cardio}`,
    ];
  } else {
    // Record-only fallback
    const diff = homeRec.pct - awayRec.pct;
    const expEdge = (homeRec.fights - awayRec.fights) * 0.004;
    pHome = Math.min(0.88, Math.max(0.12, 0.5 + diff * 1.9 + expEdge));
    pFinish = Math.min(0.78, Math.max(0.24,
      0.46 + (Math.max(pHome, 1 - pHome) - 0.5) * 0.55
        + (heavy ? 0.10 : 0)
        - (light ? 0.08 : 0)
        - (scheduledRounds === 5 ? 0.04 : 0),
    ));
    summaryLines = [
      `${weightClass}${scheduledRounds === 5 ? " · 5-round" : ""} · record-based model (ESPN stats pending)`,
    ];
  }

  const pFav = Math.max(pHome, 1 - pHome);
  const roundLine = scheduledRounds === 5 ? 2.5 : 1.5;
  const expRounds = scheduledRounds * (1 - pFinish * 0.55);
  const pRoundsOver = Math.min(0.90, Math.max(0.10, 1 - pFinish * (roundLine === 1.5 ? 0.62 : 0.78)));

  return {
    pace: statsUsed ? (awayProfile!.strikeLPM + homeProfile!.strikeLPM > 9 ? "High pace" : "Moderate pace") : "Unknown pace",
    cardio: "See summary",
    pHome,
    pAway: 1 - pHome,
    fairHomeML: american(pHome),
    fairAwayML: american(1 - pHome),
    pFinish,
    fairFinish: american(pFinish),
    fairDecision: american(1 - pFinish),
    expRounds: Math.round(expRounds * 100) / 100,
    roundLine,
    pRoundsOver,
    fairRoundsOver: american(pRoundsOver),
    fairRoundsUnder: american(1 - pRoundsOver),
    statsUsed,
    summary: summaryLines.filter(Boolean).join(" · "),
  };
}
