// Free, keyless data layer built on ESPN's public JSON feeds.
// Provides slates, odds, injuries, rest intelligence, finals for grading,
// and boxscore player stats for grading player props.

export interface TeamInfo {
  id: string;
  abbr: string;
  name: string;
  logo: string;
  color: string;
  record: string;
  homeRecord: string;
  awayRecord: string;
}

export interface InjuryInfo {
  team: string;
  player: string;
  status: string;
  detail: string;
}

export interface OddsInfo {
  provider: string;
  details: string; // e.g. "LAL -3.5"
  homeSpread: number | null; // home perspective spread
  homeSpreadOdds: number | null; // real juice on the home side
  awaySpreadOdds: number | null;
  homeML: number | null;
  awayML: number | null;
  overUnder: number | null;
  overOdds: number | null;
  underOdds: number | null;
  homeTeamTotal: number | null; // book-posted if present, else derived
  awayTeamTotal: number | null;
  teamTotalsDerived: boolean;
}

export interface PlayerLeader {
  athlete: string;
  teamAbbr: string;
  position: string;
  category: string; // espn category name
  stat: string; // our normalized stat key
  seasonValue: number; // raw value from the feed
  perGame: number | null; // normalized per-game rate
}

export interface ProbableInfo {
  role: string;
  name: string;
  shortName: string;
  position: string;
  record: string;
}

export interface RestInfo {
  homeDays: number;
  awayDays: number;
  homeB2B: boolean;
  awayB2B: boolean;
  home3in4: boolean;
  away3in4: boolean;
  homeTravel: boolean; // played on the road yesterday
  awayTravel: boolean;
}

export interface GameInfo {
  eventId: string;
  sport: string;
  sportLabel: string;
  name: string;
  matchup: string; // "AWAY @ HOME"
  startTime: string; // ISO
  status: "pre" | "in" | "post";
  statusDetail: string;
  venue: string;
  home: TeamInfo;
  away: TeamInfo;
  odds: OddsInfo | null;
  injuries: InjuryInfo[];
  rest: RestInfo | null;
  leaders: PlayerLeader[];
  context: {
    homeProbables: ProbableInfo[];
    awayProbables: ProbableInfo[];
    notes: string[];
    lineupPosted: boolean;
  };
  /** combat sports only */
  combat?: {
    weightClass: string;
    scheduledRounds: number;
    titleFight: boolean;
    cardSegment: string; // "Main Event" | "Main Card" | "Prelims"
    /** model-derived fair prices — ESPN publishes no MMA sportsbook lines */
    model: CombatModel & { statsUsed?: boolean; summary?: string };
    eventId: string;
    competitionId: string;
    league: string;
  };
}

export const SPORT_PATHS: Record<string, { label: string; path: string }> = {
  nba: { label: "NBA", path: "basketball/nba" },
  nfl: { label: "NFL", path: "football/nfl" },
  ncaaf: { label: "NCAAF", path: "football/college-football" },
  ncaab: { label: "NCAAB", path: "basketball/mens-college-basketball" },
  mlb: { label: "MLB", path: "baseball/mlb" },
  nhl: { label: "NHL", path: "hockey/nhl" },
  ufc: { label: "UFC", path: "mma/ufc" },
  dwcs: { label: "DWCS", path: "mma/ufc" }, // ESPN files DWCS under UFC
  pfl: { label: "PFL", path: "mma/pfl" },
};

/** Combat sports have no spreads/totals — they get their own market model. */
export const COMBAT_SPORTS = new Set(["ufc", "dwcs", "pfl"]);

import { combatModel, type CombatModel } from "./combat";

const API = "https://site.api.espn.com/apis/site/v2/sports";

export interface FetchDiag {
  lastUrl: string;
  lastStatus: number | string;
  lastAgent: string;
  attempts: number;
  failures: number;
}

export const fetchDiag: FetchDiag = {
  lastUrl: "",
  lastStatus: "-",
  lastAgent: "-",
  attempts: 0,
  failures: 0,
};

// ESPN's edge (Akamai) 403s full browser user-agents that lack matching
// browser fingerprints, but happily serves plain API clients. Order matters:
// the simple agent is the known-good default, the others are fallbacks in
// case a particular host/IP range gets filtered.
const UA_VARIANTS = [
  "neonslip-agent/1.0",
  "okhttp/4.12.0",
  "curl/8.4.0",
];
let uaIndex = 0;

async function jfetch(url: string, timeoutMs = 8000, retries = 2): Promise<any | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    fetchDiag.attempts++;
    fetchDiag.lastUrl = url;
    const ua = UA_VARIANTS[(uaIndex + attempt) % UA_VARIANTS.length];
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { "user-agent": ua, accept: "application/json" },
        cache: "no-store",
      });
      clearTimeout(t);
      fetchDiag.lastStatus = res.status;
      fetchDiag.lastAgent = ua;
      if (!res.ok) {
        // 403/429 => this agent is filtered here; pin the next one and retry.
        if ((res.status === 403 || res.status === 429) && attempt < retries) {
          uaIndex = (uaIndex + attempt + 1) % UA_VARIANTS.length;
          continue;
        }
        if (res.status >= 500 && attempt < retries) continue;
        fetchDiag.failures++;
        return null;
      }
      return await res.json();
    } catch (e) {
      fetchDiag.lastStatus = e instanceof Error ? e.name : "error";
      if (attempt >= retries) {
        fetchDiag.failures++;
        return null;
      }
    }
  }
  return null;
}

function toYyyymmdd(dateISO: string): string {
  return dateISO.replaceAll("-", "");
}

function addDays(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- scoreboard parsing ----------

function parseTeam(comp: any): TeamInfo {
  const t = comp?.team ?? {};
  const recs: any[] = comp?.records ?? [];
  const find = (type: string) =>
    recs.find((r) => r.type === type)?.summary ?? "";
  return {
    id: String(t.id ?? ""),
    abbr: t.abbreviation ?? "???",
    name: t.displayName ?? t.name ?? "Unknown",
    logo:
      t.logo ??
      `https://a.espncdn.com/i/teamlogos/default-team-logo-500.png`,
    color: t.color ? `#${t.color}` : "#1a2233",
    record: find("total") || recs[0]?.summary || "0-0",
    homeRecord: find("home"),
    awayRecord: find("road"),
  };
}

/** ESPN serves american odds as strings ("-110", "+154", "EVEN"). */
function americanNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  if (s === "EVEN" || s === "EV") return 100;
  const n = parseInt(s.replace(/[^\d+-]/g, ""), 10);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** Walks the nested close/open price nodes DraftKings uses. */
function priceOf(node: any): number | null {
  if (!node) return null;
  return (
    americanNum(node?.close?.odds) ??
    americanNum(node?.open?.odds) ??
    americanNum(node?.current?.odds) ??
    americanNum(node?.odds) ??
    null
  );
}

/**
 * Largest plausible point/run/goal spread per sport. Critical guard: for
 * baseball & hockey ESPN puts the MONEYLINE in `details` ("NYY -137"), so a
 * naive parse yields a -137 "spread" and nonsense derived team totals.
 */
const MAX_SPREAD: Record<string, number> = {
  mlb: 3.5, nhl: 3.5, nba: 30, ncaab: 45, nfl: 30, ncaaf: 65,
};

function plausibleSpread(v: number | null, sport?: string): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const max = sport ? (MAX_SPREAD[sport] ?? 65) : 65;
  return Math.abs(v) <= max ? v : null;
}

export function parseOdds(
  raw: any,
  homeAbbr?: string,
  awayAbbr?: string,
  sport?: string,
): OddsInfo | null {
  const list: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  // Prefer the entry that actually carries prices.
  const o =
    list.find((x) => x?.moneyline || x?.pointSpread || x?.total) ?? list[0];
  if (!o) return null;

  // --- spread (ESPN's numeric `spread` is home-perspective and trustworthy) ---
  let homeSpread: number | null = plausibleSpread(
    typeof o.spread === "number" ? o.spread : null,
    sport,
  );
  // Cross-check against the readable details string — but ONLY when the value
  // is a plausible spread for the sport. In MLB/NHL this field is a moneyline.
  const det: string = typeof o.details === "string" ? o.details : "";
  const m = det.match(/^([A-Z&.\-]{2,5})\s+([+-]?\d+(?:\.\d+)?)/);
  if (m && homeAbbr && awayAbbr) {
    const [, abbr, numStr] = m;
    const fromDetails = plausibleSpread(parseFloat(numStr), sport);
    if (fromDetails != null) {
      if (abbr === homeAbbr) homeSpread = fromDetails;
      else if (abbr === awayAbbr) homeSpread = -fromDetails;
    }
  } else if (/^(EVEN|PK)/i.test(det) && homeSpread == null) {
    homeSpread = 0;
  }

  // --- moneyline: the modern payload nests these ---
  const homeML =
    priceOf(o.moneyline?.home) ?? americanNum(o.homeTeamOdds?.moneyLine);
  const awayML =
    priceOf(o.moneyline?.away) ?? americanNum(o.awayTeamOdds?.moneyLine);

  // --- spread juice ---
  const homeSpreadOdds =
    priceOf(o.pointSpread?.home) ?? americanNum(o.homeTeamOdds?.spreadOdds);
  const awaySpreadOdds =
    priceOf(o.pointSpread?.away) ?? americanNum(o.awayTeamOdds?.spreadOdds);

  // --- total + juice ---
  const overUnder =
    typeof o.overUnder === "number"
      ? o.overUnder
      : parseFloat(String(o.total?.over?.close?.line ?? "").replace(/[^\d.]/g, "")) ||
        null;
  const overOdds = priceOf(o.total?.over) ?? americanNum(o.overOdds);
  const underOdds = priceOf(o.total?.under) ?? americanNum(o.underOdds);

  // --- team totals: use book lines when present, else derive from the
  // standard identity  TT = total/2 -/+ spread/2  (how books price them) ---
  let homeTeamTotal: number | null = o.homeTeamOdds?.total ?? null;
  let awayTeamTotal: number | null = o.awayTeamOdds?.total ?? null;
  let teamTotalsDerived = false;
  if ((homeTeamTotal == null || awayTeamTotal == null) && overUnder != null && homeSpread != null) {
    const half = overUnder / 2;
    homeTeamTotal = Math.round((half - homeSpread / 2) * 2) / 2;
    awayTeamTotal = Math.round((half + homeSpread / 2) * 2) / 2;
    teamTotalsDerived = true;
  }
  // Final sanity gate: a team total must sit strictly between 0 and the game
  // total. Anything else means an upstream field was misread — drop it rather
  // than publish a nonsense line.
  const sane = (tt: number | null): number | null =>
    tt != null && Number.isFinite(tt) && tt > 0 && (overUnder == null || tt < overUnder)
      ? tt
      : null;
  homeTeamTotal = sane(homeTeamTotal);
  awayTeamTotal = sane(awayTeamTotal);
  if (homeTeamTotal == null || awayTeamTotal == null) {
    homeTeamTotal = null;
    awayTeamTotal = null;
    teamTotalsDerived = false;
  }

  return {
    provider: o.provider?.name ?? "ESPN BET",
    details: det,
    homeSpread,
    homeSpreadOdds,
    awaySpreadOdds,
    homeML,
    awayML,
    overUnder,
    overOdds,
    underOdds,
    homeTeamTotal,
    awayTeamTotal,
    teamTotalsDerived,
  };
}

// ---------- player leaders (free player-prop source) ----------

const LEADER_STAT: Record<string, string> = {
  passingyards: "PASS_YDS",
  rushingyards: "RUSH_YDS",
  receivingyards: "REC_YDS",
  points: "PTS",
  avgpoints: "PTS",
  pointspergame: "PTS",
  rebounds: "REB",
  avgrebounds: "REB",
  reboundspergame: "REB",
  assists: "AST",
  avgassists: "AST",
  assistspergame: "AST",
  goals: "GOALS",
  shots: "SHOTS",
};

/** Plausible per-game ranges — guards against bad normalization. */
const STAT_RANGE: Record<string, [number, number]> = {
  PASS_YDS: [120, 400],
  RUSH_YDS: [25, 165],
  REC_YDS: [20, 140],
  PTS: [8, 40],
  REB: [3, 16],
  AST: [2, 13],
  GOALS: [0.2, 1.2],
  SHOTS: [1, 6],
};

function gamesPlayed(record: string): number {
  const m = record.match(/(\d+)[-–](\d+)(?:[-–](\d+))?/);
  if (!m) return 0;
  return Number(m[1]) + Number(m[2]) + Number(m[3] ?? 0);
}

export function parseLeaders(comp: any, home: TeamInfo, away: TeamInfo): PlayerLeader[] {
  const out: PlayerLeader[] = [];
  const gpByTeamId = new Map<string, number>([
    [home.id, gamesPlayed(home.record)],
    [away.id, gamesPlayed(away.record)],
  ]);
  const abbrByTeamId = new Map<string, string>([
    [home.id, home.abbr],
    [away.id, away.abbr],
  ]);

  for (const cat of comp?.leaders ?? []) {
    const key = String(cat?.name ?? "").toLowerCase();
    const stat = LEADER_STAT[key];
    if (!stat) continue;
    const isAverage = /avg|pergame/.test(key);
    for (const L of cat?.leaders ?? []) {
      const ath = L?.athlete;
      if (!ath?.displayName) continue;
      const teamId = String(ath?.team?.id ?? L?.team?.id ?? "");
      const value = typeof L?.value === "number" ? L.value : null;
      if (value == null) continue;
      const gp = gpByTeamId.get(teamId) ?? 0;
      let perGame: number | null = isAverage ? value : gp > 0 ? value / gp : null;
      const range = STAT_RANGE[stat];
      if (perGame != null && range && (perGame < range[0] || perGame > range[1])) {
        perGame = null; // implausible → don't build a prop off it
      }
      // "15/27, 297 YDS, 4 TD" → touchdown counts ride along with yardage
      const tdMatch = String(L?.displayValue ?? "").match(/(\d+)\s*TD/i);
      if (tdMatch && (stat === "PASS_YDS" || stat === "RUSH_YDS" || stat === "REC_YDS")) {
        const tds = Number(tdMatch[1]);
        // Early-season TD rates are tiny samples. Regress toward a modest
        // baseline (0.45/g skill players, 1.4/g passers) with a 4-game prior
        // so a hot two-week start can't imply a 70% anytime scorer.
        const priorRate = stat === "PASS_YDS" ? 1.4 : 0.45;
        const priorGames = 4;
        const tdPerGame =
          gp > 0 ? (tds + priorRate * priorGames) / (gp + priorGames) : null;
        if (tdPerGame != null && tdPerGame > 0 && tdPerGame < 4) {
          out.push({
            athlete: ath.displayName,
            teamAbbr: abbrByTeamId.get(teamId) ?? "",
            position: ath?.position?.abbreviation ?? "",
            category: key,
            stat: stat === "PASS_YDS" ? "PASS_TD" : "ANY_TD",
            seasonValue: tds,
            perGame: Math.round(tdPerGame * 100) / 100,
          });
        }
      }
      out.push({
        athlete: ath.displayName,
        teamAbbr: abbrByTeamId.get(teamId) ?? "",
        position: ath?.position?.abbreviation ?? "",
        category: key,
        stat,
        seasonValue: value,
        perGame: perGame != null ? Math.round(perGame * 10) / 10 : null,
      });
    }
  }
  return out;
}

function parseProbables(list: any[]): ProbableInfo[] {
  return (list ?? []).map((p) => ({
    role: p?.displayName ?? p?.name ?? "Probable",
    name: p?.athlete?.displayName ?? p?.athlete?.fullName ?? "TBA",
    shortName: p?.athlete?.shortName ?? p?.athlete?.displayName ?? "TBA",
    position:
      typeof p?.athlete?.position === "string"
        ? p.athlete.position
        : p?.athlete?.position?.abbreviation ?? "",
    record: p?.record ?? "",
  }));
}

function parseEvent(evt: any, sport: string): GameInfo {
  const comp = evt?.competitions?.[0] ?? {};
  const competitors: any[] = comp.competitors ?? [];
  const homeC = competitors.find((c) => c.homeAway === "home") ?? competitors[0];
  const awayC = competitors.find((c) => c.homeAway === "away") ?? competitors[1];
  const home = parseTeam(homeC);
  const away = parseTeam(awayC);
  const st = evt?.status?.type ?? {};
  const state: "pre" | "in" | "post" =
    st.state === "in" ? "in" : st.completed || st.state === "post" ? "post" : "pre";
  const meta = SPORT_PATHS[sport];
  return {
    eventId: String(evt.id),
    sport,
    sportLabel: meta?.label ?? sport.toUpperCase(),
    name: evt.name ?? `${away.name} at ${home.name}`,
    matchup: `${away.abbr} @ ${home.abbr}`,
    startTime: evt.date ?? comp.date ?? "",
    status: state,
    statusDetail: st.shortDetail ?? st.detail ?? "",
    venue: comp.venue?.fullName ?? "",
    home,
    away,
    odds: parseOdds(comp.odds, home.abbr, away.abbr, sport),
    injuries: [],
    rest: null,
    leaders: parseLeaders(comp, home, away),
    context: {
      homeProbables: parseProbables(homeC?.probables ?? []),
      awayProbables: parseProbables(awayC?.probables ?? []),
      notes: (comp?.notes ?? []).map((n: any) => n?.headline).filter(Boolean),
      lineupPosted: false,
    },
  };
}

// ---------- combat sports ----------
// An MMA "event" is a whole card; each `competition` is one bout. We flatten
// bouts into individual analyzable games so the cluster prices every fight.

function fighterInfo(c: any, fallbackIdx: number): TeamInfo {
  const a = c?.athlete ?? {};
  const full: string = a.displayName ?? a.fullName ?? `Fighter ${fallbackIdx + 1}`;
  const last = full.split(" ").slice(-1)[0] ?? full;
  const rec = (c?.records ?? [])[0]?.summary ?? "0-0-0";
  return {
    id: String(a.id ?? c?.id ?? fallbackIdx),
    abbr: last.slice(0, 12).toUpperCase(),
    name: full,
    logo: a?.flag?.href ?? a?.headshot ?? "",
    color: "#1a2233",
    record: rec,
    homeRecord: "",
    awayRecord: "",
  };
}

function parseBout(bout: any, card: any, sport: string): GameInfo {
  const cs: any[] = bout?.competitors ?? [];
  const a = fighterInfo(cs[0] ?? {}, 0);
  const b = fighterInfo(cs[1] ?? {}, 1);
  const st = bout?.status?.type ?? {};
  const state: "pre" | "in" | "post" =
    st.state === "in" ? "in" : st.completed || st.state === "post" ? "post" : "pre";
  const rounds = Number(bout?.format?.regulation?.periods ?? 3) || 3;
  const weight = bout?.type?.abbreviation ?? bout?.type?.text ?? "Catchweight";
  const meta = SPORT_PATHS[sport];
  const cardId = String(card?.id ?? "");
  const boutId = String(bout.id);
  const league = sport === "pfl" ? "pfl" : "ufc";
  return {
    eventId: boutId,
    sport,
    sportLabel: meta?.label ?? sport.toUpperCase(),
    name: `${a.name} vs ${b.name}`,
    matchup: `${a.abbr} vs ${b.abbr}`,
    startTime: bout.date ?? card?.date ?? "",
    status: state,
    statusDetail: st.shortDetail ?? st.detail ?? "",
    venue: card?.venues?.[0]?.fullName ?? bout?.venue?.fullName ?? "",
    home: b,
    away: a,
    odds: null, // ESPN's free combat feed carries no sportsbook lines
    injuries: [],
    rest: null,
    leaders: [],
    context: {
      homeProbables: [],
      awayProbables: [],
      notes: [],
      lineupPosted: false,
    },
    combat: {
      weightClass: String(weight),
      scheduledRounds: rounds,
      titleFight: rounds === 5,
      cardSegment: rounds === 5 ? "Main Card" : "Undercard",
      model: { ...combatModel(a.record, b.record, String(weight), rounds), statsUsed: false, summary: "" },
      eventId: cardId,
      competitionId: boutId,
      league,
    },
  };
}

/** Flattens every bout on every card that falls on the requested date. */
function parseCombatCards(events: any[], sport: string, dateISO: string): GameInfo[] {
  const out: GameInfo[] = [];
  for (const card of events) {
    const bouts: any[] = card?.competitions ?? [];
    for (const bout of bouts) {
      const when = String(bout?.date ?? card?.date ?? "");
      // ESPN returns the card under several dates; keep bouts on the target day
      // (ET calendar day, matching how slates are presented).
      if (when) {
        const etDay = new Date(when).toLocaleDateString("en-CA", {
          timeZone: "America/New_York",
        });
        if (etDay !== dateISO) continue;
      }
      out.push(parseBout(bout, card, sport));
    }
  }
  return out;
}

async function scoreboard(sport: string, dateISO: string): Promise<any[]> {
  const meta = SPORT_PATHS[sport];
  if (!meta) return [];
  const data = await jfetch(
    `${API}/${meta.path}/scoreboard?dates=${toYyyymmdd(dateISO)}&limit=400`,
  );
  return data?.events ?? [];
}

// ---------- rest intelligence ----------

interface TeamDay {
  abbrs: Set<string>;
  homeAbbrs: Set<string>;
}

async function teamDaysBack(
  sport: string,
  dateISO: string,
  back: number,
): Promise<TeamDay[]> {
  // Parallel: 3 sequential round-trips per sport was the main latency sink.
  const days = await Promise.all(
    Array.from({ length: back }, (_, i) => scoreboard(sport, addDays(dateISO, -(i + 1)))),
  );
  return days.map((events) => {
    const abbrs = new Set<string>();
    const homeAbbrs = new Set<string>();
    for (const evt of events) {
      const g = parseEvent(evt, sport);
      abbrs.add(g.home.abbr);
      abbrs.add(g.away.abbr);
      homeAbbrs.add(g.home.abbr);
    }
    return { abbrs, homeAbbrs };
  });
}

export function computeRest(homeAbbr: string, awayAbbr: string, days: TeamDay[]): RestInfo {
  const played = (abbr: string, i: number) => days[i]?.abbrs.has(abbr) ?? false;
  const homeB2B = played(homeAbbr, 0);
  const awayB2B = played(awayAbbr, 0);
  const daysSince = (abbr: string) => {
    for (let i = 0; i < days.length; i++) if (played(abbr, i)) return i;
    return 3; // 3+ days rest
  };
  const countLast3 = (abbr: string) =>
    (days[0]?.abbrs.has(abbr) ? 1 : 0) +
    (days[1]?.abbrs.has(abbr) ? 1 : 0) +
    (days[2]?.abbrs.has(abbr) ? 1 : 0);
  return {
    homeDays: daysSince(homeAbbr),
    awayDays: daysSince(awayAbbr),
    homeB2B,
    awayB2B,
    home3in4: countLast3(homeAbbr) >= 2,
    away3in4: countLast3(awayAbbr) >= 2,
    homeTravel: played(homeAbbr, 0) && !days[0]!.homeAbbrs.has(homeAbbr),
    awayTravel: played(awayAbbr, 0) && !days[0]!.homeAbbrs.has(awayAbbr),
  };
}

// ---------- summary enrichment (injuries + deeper odds) ----------

async function summary(sport: string, eventId: string): Promise<any | null> {
  const meta = SPORT_PATHS[sport];
  if (!meta) return null;
  return jfetch(`${API}/${meta.path}/summary?event=${eventId}`);
}

export function parseInjuries(data: any): InjuryInfo[] {
  const out: InjuryInfo[] = [];
  for (const teamBlock of data?.injuries ?? []) {
    const team = teamBlock?.team?.abbreviation ?? teamBlock?.team?.displayName ?? "";
    for (const inj of teamBlock?.injuries ?? []) {
      out.push({
        team,
        player: inj?.athlete?.displayName ?? "Unknown",
        status: inj?.status ?? inj?.type ?? "?",
        detail:
          inj?.details?.type ??
          inj?.details?.detail ??
          inj?.type ??
          "",
      });
    }
  }
  return out;
}

// ---------- slate ----------

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface SlateOptions {
  /** Wall-clock budget for the whole fetch. Enrichment degrades gracefully. */
  budgetMs?: number;
  /** Pull prior-3-day schedules to derive rest/B2B intel. */
  withRest?: boolean;
  /** Pull per-game injury reports (1 request per game — the expensive part). */
  withInjuries?: boolean;
  /** Hard cap on injury lookups regardless of remaining budget. */
  maxInjuryLookups?: number;
}

export interface SlateResult {
  games: GameInfo[];
  degraded: string[];
  elapsedMs: number;
}

/**
 * Slate loader built for serverless time limits.
 * The scoreboard (the only mandatory call) resolves first, so games ALWAYS
 * render; rest and injury intel are layered on only while budget remains.
 */
export async function getSlateDetailed(
  dateISO: string,
  sports: string[],
  opts: SlateOptions = {},
): Promise<SlateResult> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 9000;
  const withRest = opts.withRest ?? true;
  const withInjuries = opts.withInjuries ?? true;
  const maxInjury = opts.maxInjuryLookups ?? 30;
  const degraded: string[] = [];
  const left = () => budgetMs - (Date.now() - started);

  // ---- Stage 1 (mandatory): scoreboards, all sports in parallel ----
  const boards = await Promise.all(
    sports.map(async (sport) => {
      const raw = await scoreboard(sport, dateISO);
      return {
        sport,
        games: COMBAT_SPORTS.has(sport)
          ? parseCombatCards(raw, sport, dateISO)
          : raw.map((evt) => parseEvent(evt, sport)),
      };
    }),
  );
  const games = boards.flatMap((b) => b.games);

  // ---- Stage 2 (optional): rest intelligence ----
  if (withRest && left() > 2500) {
    try {
      const restBySport = await Promise.all(
        boards
          .filter((b) => !COMBAT_SPORTS.has(b.sport)) // fighters have camps, not B2Bs
          .map(async (b) => ({
            sport: b.sport,
            days: await teamDaysBack(b.sport, dateISO, 3),
          })),
      );
      const map = new Map(restBySport.map((r) => [r.sport, r.days]));
      for (const g of games) {
        const days = map.get(g.sport);
        if (days) g.rest = computeRest(g.home.abbr, g.away.abbr, days);
      }
    } catch {
      degraded.push("rest intel unavailable");
    }
  } else if (withRest) {
    degraded.push("rest intel skipped (time budget)");
  }

  // ---- Stage 3 (optional): injuries, budget-aware ----
  if (withInjuries) {
    const targets = games
      .filter((g) => g.status === "pre" && !COMBAT_SPORTS.has(g.sport))
      .sort((a, b) => new Date(a.startTime || 0).getTime() - new Date(b.startTime || 0).getTime())
      .slice(0, maxInjury);
    let done = 0;
    if (targets.length && left() > 2000) {
      await mapLimit(targets, 8, async (g) => {
        if (left() < 1200) return g; // stop enriching, keep what we have
        const sum = await summary(g.sport, g.eventId);
        if (sum) {
          g.injuries = parseInjuries(sum);
          if (!g.odds && sum.pickcenter)
            g.odds = parseOdds(sum.pickcenter, g.home.abbr, g.away.abbr, g.sport);
          if (!g.leaders.length && sum.leaders)
            g.leaders = parseLeaders({ leaders: sum.leaders }, g.home, g.away);
          const prePlayers = sum?.boxscore?.players ?? [];
          g.context.lineupPosted = prePlayers.some(
            (t: any) => (t?.statistics ?? []).length > 0 || (t?.athletes ?? []).length > 0,
          );
          const note = g.context.lineupPosted
            ? "starting lineups posted"
            : g.sport === "mlb"
              ? "batting lineups pending"
              : "starting lineups pending";
          if (!g.context.notes.includes(note)) g.context.notes.unshift(note);
        }
        done++;
        return g;
      });
    }
    if (done < targets.length) {
      degraded.push(`injury reports partial (${done}/${targets.length})`);
    }
  }

  games.sort(
    (a, b) => new Date(a.startTime || 0).getTime() - new Date(b.startTime || 0).getTime(),
  );
  return { games, degraded, elapsedMs: Date.now() - started };
}

export async function getSlate(
  dateISO: string,
  sports: string[],
  opts: SlateOptions = {},
): Promise<GameInfo[]> {
  return (await getSlateDetailed(dateISO, sports, opts)).games;
}

// ---------- finals for grading ----------

export interface FinalScore {
  eventId: string;
  status: "pre" | "in" | "post";
  homeAbbr: string;
  awayAbbr: string;
  homeScore: number;
  awayScore: number;
  /** Per-period scoring: quarters / innings / periods, in order. */
  homeLine: number[];
  awayLine: number[];
  /** combat sports resolution */
  winnerName?: string;
  endRound?: number;
  elapsedMinutes?: number;
  scheduledRounds?: number;
  wentDistance?: boolean;
}

export async function getFinals(
  dateISO: string,
  sport: string,
): Promise<FinalScore[]> {
  const events = await scoreboard(sport, dateISO);

  if (COMBAT_SPORTS.has(sport)) {
    const out: FinalScore[] = [];
    for (const card of events) {
      for (const bout of card?.competitions ?? []) {
        const st = bout?.status ?? {};
        const type = st?.type ?? {};
        const cs: any[] = bout?.competitors ?? [];
        const a = fighterInfo(cs[0] ?? {}, 0);
        const b = fighterInfo(cs[1] ?? {}, 1);
        const winnerC = cs.find((c) => c?.winner === true);
        const rounds = Number(bout?.format?.regulation?.periods ?? 3) || 3;
        const endRound = Number(st?.period ?? 0) || 0;
        // ESPN reports the stoppage time as elapsed within the final round.
        const clk = String(st?.displayClock ?? "0:00");
        const [mm, ss] = clk.split(":").map((n) => Number(n) || 0);
        const elapsed = Math.max(0, (endRound - 1) * 5 + mm + ss / 60);
        const wentDistance = endRound >= rounds && mm >= 5;
        out.push({
          eventId: String(bout.id),
          status: type.state === "in" ? "in" : type.completed ? "post" : "pre",
          homeAbbr: b.abbr,
          awayAbbr: a.abbr,
          homeScore: winnerC && fighterInfo(winnerC, 1).abbr === b.abbr ? 1 : 0,
          awayScore: winnerC && fighterInfo(winnerC, 0).abbr === a.abbr ? 1 : 0,
          homeLine: [],
          awayLine: [],
          winnerName: winnerC ? fighterInfo(winnerC, 0).name : undefined,
          endRound,
          elapsedMinutes: Math.round(elapsed * 100) / 100,
          scheduledRounds: rounds,
          wentDistance,
        });
      }
    }
    return out;
  }

  return events.map((evt) => {
    const comp = evt?.competitions?.[0] ?? {};
    const cs: any[] = comp.competitors ?? [];
    const home = cs.find((c) => c.homeAway === "home");
    const away = cs.find((c) => c.homeAway === "away");
    const st = evt?.status?.type ?? {};
    const line = (c: any): number[] =>
      (c?.linescores ?? [])
        .map((l: any) => Number(l?.value ?? l?.displayValue ?? NaN))
        .filter((n: number) => Number.isFinite(n));
    return {
      eventId: String(evt.id),
      status: st.state === "in" ? "in" : st.completed || st.state === "post" ? "post" : "pre",
      homeAbbr: home?.team?.abbreviation ?? "?",
      awayAbbr: away?.team?.abbreviation ?? "?",
      homeScore: Number(home?.score ?? 0),
      awayScore: Number(away?.score ?? 0),
      homeLine: line(home),
      awayLine: line(away),
    };
  });
}

// ---------- boxscore player stats (prop grading) ----------

// Keys that ESPN uses in boxscore group `keys` arrays. We check both the
// camelCase canonical key AND the short label so we survive ESPN reformatting.
const STAT_KEY_MAP: Record<string, string[]> = {
  // NFL / NCAAF
  PASS_YDS: ["passingYards", "YDS"],
  PASS_TD: ["passingTouchdowns", "TD"],
  RUSH_YDS: ["rushingYards", "YDS"],
  RUSH_TD: ["rushingTouchdowns", "TD"],
  REC_YDS: ["receivingYards", "YDS"],
  REC_TD: ["receivingTouchdowns", "TD"],
  REC: ["receptions", "REC"],
  // ANY_TD — look for total touchdowns from all groups
  ANY_TD: ["passingTouchdowns", "rushingTouchdowns", "receivingTouchdowns", "TD"],
  // NBA / NCAAB
  PTS: ["points", "PTS"],
  REB: ["rebounds", "totalRebounds", "REB"],
  AST: ["assists", "AST"],
  THREES: ["threePointersMade", "3PM", "3PT"],
  STL: ["steals", "STL"],
  BLK: ["blocks", "BLK"],
  // NHL
  GOALS: ["goals", "G"],
  SHOTS: ["shotsOnGoal", "STOT", "SOG", "S"],
  // MLB
  HITS: ["hits", "H"],
  WALKS: ["walks", "BB"],
  TOTAL_BASES: ["totalBases", "TB"],
  HOME_RUNS: ["homeRuns", "HR"],
  PITCHER_K: ["strikeouts", "SO", "K"],
  PITCHER_OUTS: ["outsRecorded", "OUTS"],
};

function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, "")
    .trim();
}

export async function lookupPlayerStat(
  sport: string,
  eventId: string,
  player: string,
  stat: string,
): Promise<number | null> {
  const sum = await summary(sport, eventId);
  const groups = sum?.boxscore?.players ?? [];
  const target = normName(player);

  // Which ESPN boxscore group(s) to search in for this stat.
  const wantGroups: string[] | null =
    stat === "PASS_YDS" || stat === "PASS_TD" ? ["passing"] :
    stat === "RUSH_YDS" || stat === "RUSH_TD" ? ["rushing"] :
    stat === "REC_YDS" || stat === "REC" || stat === "REC_TD" ? ["receiving"] :
    stat === "ANY_TD" ? ["passing", "rushing", "receiving"] :
    null; // search all groups

  const aliases = STAT_KEY_MAP[stat] ?? [stat];
  let tdTotal = 0;
  let foundPlayer = false;

  for (const teamBlock of groups) {
    for (const grp of teamBlock?.statistics ?? []) {
      const gname = String(grp?.name ?? "").toLowerCase();
      if (wantGroups && !wantGroups.some((g) => gname.includes(g))) continue;

      // ESPN uses both `keys` (camelCase names) and `labels` (short display)
      const keys: string[] = grp?.keys ?? [];
      const labels: string[] = grp?.labels ?? [];

      for (const ath of grp?.athletes ?? []) {
        const name = normName(ath?.athlete?.displayName ?? "");
        if (!name) continue;
        // Fuzzy name match: either direction of inclusion
        const nameMatch =
          name === target ||
          name.includes(target) ||
          target.includes(name) ||
          // Also try last-name only match for short names like "J. Allen"
          (target.split(" ").pop()?.length ?? 0) > 3 && name.includes(target.split(" ").pop()!);
        if (!nameMatch) continue;

        const stats: string[] = ath?.stats ?? [];

        // For ANY_TD: sum TDs from all groups for this player
        if (stat === "ANY_TD") {
          for (const alias of ["rushingTouchdowns", "receivingTouchdowns", "passingTouchdowns", "TD"]) {
            let idx = keys.findIndex((k) => k === alias);
            if (idx < 0) idx = labels.findIndex((l) => l.toUpperCase() === alias.toUpperCase());
            if (idx >= 0 && stats[idx] != null) {
              const n = parseFloat(String(stats[idx]).replace(/[^\d]/g, "")) || 0;
              tdTotal += n;
              foundPlayer = true;
              break; // one TD column per group
            }
          }
          continue;
        }

        // Regular stat lookup: check keys first (canonical), then labels
        for (const alias of aliases) {
          let idx = keys.findIndex((k) => k === alias || k.toLowerCase() === alias.toLowerCase());
          if (idx < 0) {
            idx = labels.findIndex(
              (l) => l.toUpperCase() === alias.toUpperCase() || l.replace(/[^a-zA-Z]/g, "").toUpperCase() === alias,
            );
          }
          if (idx >= 0 && stats[idx] != null) {
            // Handle compound stats like "32/52" — take first number
            const raw = String(stats[idx]);
            const n = parseFloat(raw.split("/")[0].replace(/[^\d.-]/g, ""));
            if (Number.isFinite(n)) return n;
          }
        }
      }
    }
  }

  if (stat === "ANY_TD" && foundPlayer) return tdTotal;
  return null;
}
