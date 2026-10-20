/**
 * Real UFC/MMA fighter statistics from ESPN's core API.
 * Returns career metrics: striking rate, accuracy, TD rate, finish percentages.
 * Reach and stance are also fetched for the style-matchup model.
 * This is a distinct API host (sports.core.api.espn.com) that carries
 * much richer data than the public scoreboard endpoint.
 *
 * The same host also publishes per-fight statistics (significant strikes,
 * takedowns) and — when ESPN has them — pre-fight moneylines, which we use
 * for grading the volume props and for real prices respectively.
 */

import { buildMmaModel, legacyFromModel, type LegacyCombat, type MmaModel, type Promotion } from "./mma-model";

const CORE = "https://sports.core.api.espn.com/v2/sports/mma";

export interface FighterProfile {
  athleteId: string;
  displayName: string;
  /** false when ESPN returned no career statistics for this fighter */
  hasStats: boolean;
  reach: number | null; // inches
  height: number | null; // inches
  stance: string; // "Orthodox" | "Southpaw" | "Switch" | "Unknown"
  // career per-minute & percentage stats
  strikeLPM: number; // significant strikes landed per minute
  strikeAccuracy: number; // 0-100
  strikeDefense: number; // 0-100 (absorbed / attempted against)
  takedownAvg: number; // per 15 min
  takedownAccuracy: number; // 0-100
  takedownDefense: number; // 0-100
  submissionAvg: number; // per 15 min
  koTkoPct: number; // KO + TKO finish %
  decisionPct: number; // decision win %
  // derived finish tendency
  finishRate: number; // probability fight ends inside distance (0-1)
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

/** ESPN `$ref` links sometimes point at an internal `.pvt` host. */
const publicRef = (ref: string): string => ref.replace("sports.core.api.espn.pvt", "sports.core.api.espn.com");

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
  league: "ufc" | "pfl" = "ufc",
): Promise<FighterProfile | null> {
  const [ath, primary] = await Promise.all([
    jfetch(`${CORE}/athletes/${athleteId}?lang=en&region=us`),
    jfetch(`${CORE}/athletes/${athleteId}/statistics?lang=en&region=us`),
  ]);
  if (!ath) return null;
  // Some deployments only serve career stats from the league-scoped path.
  const statsData =
    primary?.splits?.categories?.length
      ? primary
      : await jfetch(`${CORE}/leagues/${league}/athletes/${athleteId}/statistics?lang=en&region=us`);

  const stance =
    typeof ath.stance === "string"
      ? ath.stance
      : (ath.stance as any)?.text ?? "Unknown";

  const cats: any[] = statsData?.splits?.categories ?? [];
  const s = readStats(cats);
  const hasStats = s["strikeLPM"] !== undefined || s["takedownAvg"] !== undefined;

  const koTkoPct = (s["koPercentage"] ?? 0) + (s["tkoPercentage"] ?? 0);
  const decPct = s["decisionPercentage"] ?? 33;
  // Infer finish rate from decision percentage: (100 - decision%) = finish%.
  // ESPN's decisionPercentage counts only decision WINS as a % of total fights,
  // so a 22% decision rate means ~78% of wins ended by finish — but total
  // fights includes losses, so we need to be conservative.
  // Use: finishRate ≈ 1 - min(decPct/50, 0.80) — caps so pure decisions aren't 100%
  const impliedFinish = 1 - Math.min(decPct / 50, 0.8);
  const explicitFinish = koTkoPct / 100 + (s["submissionAvg"] ?? 0) * 0.25;
  const finishRate = Math.min(
    0.82,
    Math.max(
      0.18,
      koTkoPct > 0 || (s["submissionAvg"] ?? 0) > 0.5
        ? Math.max(impliedFinish, explicitFinish)
        : impliedFinish,
    ),
  );

  return {
    athleteId,
    displayName: ath.displayName ?? ath.fullName ?? "Unknown",
    hasStats,
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

export interface BoutProfiles {
  away: FighterProfile | null;
  home: FighterProfile | null;
  /** ESPN competitor ids (== athlete ids in MMA); used to read per-fight stats */
  ids: { away: string | null; home: string | null };
}

async function competitorAthleteId(ref: string | undefined): Promise<{ competitorId: string | null; athleteId: string | null }> {
  if (!ref) return { competitorId: null, athleteId: null };
  const competitorId = ref.match(/competitors\/(\d+)/)?.[1] ?? null;
  const comp = await jfetch(publicRef(ref));
  const athRef: string | undefined = comp?.athlete?.$ref;
  const athleteId = athRef?.match(/athletes\/(\d+)/)?.[1] ?? competitorId;
  return { competitorId, athleteId };
}

/**
 * Pull both fighters' profiles from the competitor list in an upcoming bout.
 * ESPN nests athlete IDs inside the competition's competitor refs.
 */
export async function fetchBoutProfiles(
  eventId: string,
  competitionId: string,
  league: "ufc" | "pfl",
): Promise<BoutProfiles> {
  const empty: BoutProfiles = { away: null, home: null, ids: { away: null, home: null } };
  const base = `${CORE}/leagues/${league}/events/${eventId}/competitions/${competitionId}/competitors`;
  const compList = await jfetch(`${base}?lang=en&region=us`);
  if (!compList?.items?.length) return empty;

  const refs: (string | undefined)[] = compList.items
    .slice(0, 2)
    .map((item: any) => (typeof item === "string" ? item : item?.$ref));

  const both = await Promise.all(
    refs.map(async (ref) => {
      const { competitorId, athleteId } = await competitorAthleteId(ref);
      const profile = athleteId ? await fetchFighterProfile(athleteId, league) : null;
      return { competitorId: competitorId ?? athleteId, profile };
    }),
  );

  return {
    away: both[0]?.profile ?? null,
    home: both[1]?.profile ?? null,
    ids: { away: both[0]?.competitorId ?? null, home: both[1]?.competitorId ?? null },
  };
}

// ---------------------------------------------------------------------------
// optional real moneylines (ESPN publishes these for some cards)
// ---------------------------------------------------------------------------

function americanFrom(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) >= 100) return v;
  if (typeof v === "string") {
    const s = v.trim().toUpperCase();
    if (s === "EVEN" || s === "EV") return 100;
    const n = parseInt(s.replace(/[^\d+-]/g, ""), 10);
    if (Number.isInteger(n) && Math.abs(n) >= 100) return n;
  }
  return null;
}

function moneylineOf(node: any): number | null {
  if (!node || typeof node !== "object") return null;
  return (
    americanFrom(node.moneyLine) ??
    americanFrom(node.moneyline) ??
    americanFrom(node.current?.moneyLine) ??
    americanFrom(node.close?.moneyLine) ??
    americanFrom(node.open?.moneyLine) ??
    americanFrom(node.odds) ??
    americanFrom(node.current?.odds) ??
    americanFrom(node.close?.odds) ??
    null
  );
}

/**
 * Parse an ESPN core `odds` payload into per-fighter moneylines.
 *
 * Safety first: a moneyline is only accepted when BOTH fighters are matched
 * to an entry by their athlete id. Mapping by position could silently swap the
 * two prices, so if any entry can't be identified we return null and the
 * engine keeps using its own model price instead.
 */
export function parseMmaMoneylines(
  payload: any,
  awayId: string | null,
  homeId: string | null,
): { away: number; home: number } | null {
  if (!awayId || !homeId || awayId === homeId) return null;
  const items: any[] = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
  for (const item of items) {
    const found = new Map<string, number>();
    const nodes: any[] = [
      item?.awayAthleteOdds,
      item?.homeAthleteOdds,
      item?.awayTeamOdds,
      item?.homeTeamOdds,
      ...(Array.isArray(item?.competitors) ? item.competitors : []),
    ].filter(Boolean);
    for (const node of nodes) {
      const ref: string | undefined = node?.athlete?.$ref ?? node?.team?.$ref ?? node?.competitor?.$ref;
      const id = ref?.match(/(?:athletes|competitors)\/(\d+)/)?.[1] ?? (node?.athlete?.id ? String(node.athlete.id) : undefined);
      const ml = moneylineOf(node);
      if (id && ml != null) found.set(id, ml);
    }
    const a = found.get(awayId);
    const h = found.get(homeId);
    if (a == null || h == null) continue;
    // sanity: two sides of one fight price to ~100-115% combined
    const imp = (x: number) => (x < 0 ? -x / (-x + 100) : 100 / (x + 100));
    const total = imp(a) + imp(h);
    if (total < 0.98 || total > 1.2) continue;
    return { away: a, home: h };
  }
  return null;
}

export async function fetchBoutMoneylines(
  league: "ufc" | "pfl",
  eventId: string,
  competitionId: string,
  awayId: string | null,
  homeId: string | null,
): Promise<{ away: number; home: number } | null> {
  const data = await jfetch(
    `${CORE}/leagues/${league}/events/${eventId}/competitions/${competitionId}/odds?lang=en&region=us`,
    5000,
  );
  return parseMmaMoneylines(data, awayId, homeId);
}

// ---------------------------------------------------------------------------
// post-fight statistics (used to grade significant strikes / takedown props)
// ---------------------------------------------------------------------------

export interface FightStatLine {
  sigStrikesLanded: number | null;
  takedownsLanded: number | null;
}

interface RawStat {
  key: string;
  value: number;
}

const compact = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Walk any JSON shape and collect named numeric statistics. */
function collectStats(node: any, out: RawStat[], depth = 0): void {
  if (!node || typeof node !== "object" || depth > 7) return;
  if (Array.isArray(node)) {
    for (const x of node) collectStats(x, out, depth + 1);
    return;
  }
  const name = node.name ?? node.displayName ?? node.abbreviation;
  if (typeof name === "string") {
    let value: number | null = null;
    if (typeof node.value === "number") value = node.value;
    else if (typeof node.value === "string" && node.value.trim() !== "" && Number.isFinite(Number(node.value))) value = Number(node.value);
    else if (typeof node.displayValue === "string") {
      const m = node.displayValue.match(/^\s*(\d+(?:\.\d+)?)/);
      if (m) value = Number(m[1]);
    }
    if (value != null) {
      // One entry per identifier. ESPN stats usually carry several (name AND
      // displayName AND abbreviation); joining them into one key would break
      // every exact match.
      for (const id of [node.name, node.displayName, node.abbreviation]) {
        const key = compact(id);
        if (key) out.push({ key, value });
      }
    }
  }
  for (const v of Object.values(node)) collectStats(v, out, depth + 1);
}

const SIG_NAMES = new Set(["sigstrikeslanded", "significantstrikeslanded", "sigstrikes", "significantstrikes", "sigstrikesmade"]);
const TD_NAMES = new Set(["takedownslanded", "takedowns", "takedownscompleted", "takedownssuccessful", "takedownsmade"]);
const NOT_A_COUNT = ["attempt", "pct", "percent", "accuracy", "def", "absorb", "avg", "per", "rate", "head", "body", "leg", "distance", "clinch", "ground"];

function pickCount(stats: RawStat[], names: Set<string>, loose: RegExp): number | null {
  const ok = stats.filter((s) => !NOT_A_COUNT.some((bad) => s.key.includes(bad)));
  // exact names win over looser matches
  for (const s of ok) if (names.has(s.key)) return s.value;
  for (const s of ok) if (loose.test(s.key)) return s.value;
  return null;
}

/** Extract the two counts we grade from a core `statistics` payload. */
export function parseFightStatLine(payload: any): FightStatLine {
  const stats: RawStat[] = [];
  collectStats(payload, stats);
  return {
    // The exclusion list (attempts, %, targets, defence, per-minute…) has already removed
    // everything that is not a plain count, so the fallback can be broad.
    sigStrikesLanded: pickCount(stats, SIG_NAMES, /(sig|significant)strike/),
    takedownsLanded: pickCount(stats, TD_NAMES, /takedown/),
  };
}

export async function fetchFightStatLine(
  league: "ufc" | "pfl",
  eventId: string,
  competitionId: string,
  competitorId: string,
): Promise<FightStatLine | null> {
  const data = await jfetch(
    `${CORE}/leagues/${league}/events/${eventId}/competitions/${competitionId}/competitors/${competitorId}/statistics?lang=en&region=us`,
    7000,
  );
  if (!data) return null;
  return parseFightStatLine(data);
}

// ---------------------------------------------------------------------------
// enhanced model used by the slate + engine
// ---------------------------------------------------------------------------

export type EnhancedCombat = LegacyCombat & {
  statsUsed: boolean;
  summary: string;
  pace: string;
  cardio: string;
  /** the full joint model every MMA market is derived from */
  dist: MmaModel;
};

export function buildEnhancedCombatModel(
  awayRecord: string,
  homeRecord: string,
  weightClass: string,
  scheduledRounds: number,
  awayProfile: FighterProfile | null,
  homeProfile: FighterProfile | null,
  promotion: Promotion = "ufc",
): EnhancedCombat {
  const dist = buildMmaModel({
    weightClass,
    scheduledRounds,
    promotion,
    away: { record: awayRecord, profile: awayProfile },
    home: { record: homeRecord, profile: homeProfile },
  });
  const legacy = legacyFromModel(dist);
  const rounds = dist.rounds;
  const have = !!(awayProfile?.hasStats && homeProfile?.hasStats);

  let pace = "Unknown pace";
  let cardio = "See summary";
  const lines: string[] = [];

  if (have && awayProfile && homeProfile) {
    const aStrk = awayProfile.strikeLPM;
    const hStrk = homeProfile.strikeLPM;
    const stanceNote =
      awayProfile.stance === homeProfile.stance
        ? `both ${awayProfile.stance.toLowerCase()}`
        : `${awayProfile.stance.toLowerCase()} vs ${homeProfile.stance.toLowerCase()}`;
    const reachNote =
      awayProfile.reach && homeProfile.reach
        ? `reach ${awayProfile.reach}" vs ${homeProfile.reach}"`
        : "";
    const strkEdge = (aStrk - hStrk) / Math.max(1, aStrk + hStrk);
    const strNote =
      strkEdge > 0.05
        ? `${awayProfile.displayName} has the striking edge (${aStrk.toFixed(1)} SLpM vs ${hStrk.toFixed(1)})`
        : strkEdge < -0.05
          ? `${homeProfile.displayName} is the sharper striker (${hStrk.toFixed(1)} SLpM vs ${aStrk.toFixed(1)})`
          : `striking output is similar (${aStrk.toFixed(1)} vs ${hStrk.toFixed(1)} SLpM)`;
    const aTD = awayProfile.takedownAvg;
    const hTD = homeProfile.takedownAvg;
    const tdNote =
      aTD > 1 || hTD > 1
        ? `takedowns per 15: ${awayProfile.displayName} ${aTD.toFixed(1)} (${awayProfile.takedownAccuracy.toFixed(0)}% acc) vs ${homeProfile.displayName} ${hTD.toFixed(1)} (${homeProfile.takedownAccuracy.toFixed(0)}% acc)`
        : "neither fighter shows significant wrestling volume";
    const combined = aStrk + hStrk;
    pace = combined > 9 ? "High pace" : combined > 6.5 ? "Moderate pace" : "Slow pace";
    const cardioOf = (p: FighterProfile) => (p.decisionPct > 40 ? "proven" : p.decisionPct < 15 ? "suspect" : "average");
    cardio = `${awayProfile.displayName} cardio is ${cardioOf(awayProfile)}, ${homeProfile.displayName} is ${cardioOf(homeProfile)}`;
    lines.push(
      `${weightClass}${rounds === 5 ? " · 5-round" : ""}`,
      stanceNote + (reachNote ? ` · ${reachNote}` : ""),
      strNote,
      tdNote,
      `${pace}. ${cardio}. Model: ${(dist.pFinish * 100).toFixed(0)}% finish, ${(dist.pDecision * 100).toFixed(0)}% decision.`,
    );
  } else {
    lines.push(
      `${weightClass}${rounds === 5 ? " · 5-round" : ""} · record-based model (ESPN fighter stats unavailable)`,
    );
  }

  return {
    ...legacy,
    statsUsed: have,
    summary: lines.filter(Boolean).join(" · "),
    pace,
    cardio,
    dist,
  };
}
