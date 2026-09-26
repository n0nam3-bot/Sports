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
}

export const SPORT_PATHS: Record<string, { label: string; path: string }> = {
  nba: { label: "NBA", path: "basketball/nba" },
  nfl: { label: "NFL", path: "football/nfl" },
  ncaaf: { label: "NCAAF", path: "football/college-football" },
  ncaab: { label: "NCAAB", path: "basketball/mens-college-basketball" },
  mlb: { label: "MLB", path: "baseball/mlb" },
  nhl: { label: "NHL", path: "hockey/nhl" },
};

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

export function parseOdds(raw: any, homeAbbr?: string, awayAbbr?: string): OddsInfo | null {
  const list: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  // Prefer the entry that actually carries prices.
  const o =
    list.find((x) => x?.moneyline || x?.pointSpread || x?.total) ?? list[0];
  if (!o) return null;

  // --- spread (ESPN's `spread` is already home-perspective) ---
  let homeSpread: number | null =
    typeof o.spread === "number" ? o.spread : null;
  // Authoritative cross-check against the human-readable details string.
  const det: string = typeof o.details === "string" ? o.details : "";
  const m = det.match(/^([A-Z&.\-]{2,5})\s+([+-]?\d+(?:\.\d+)?)/);
  if (m && homeAbbr && awayAbbr) {
    const [, abbr, numStr] = m;
    const num = parseFloat(numStr);
    if (abbr === homeAbbr) homeSpread = num;
    else if (abbr === awayAbbr) homeSpread = -num;
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
    odds: parseOdds(comp.odds, home.abbr, away.abbr),
    injuries: [],
    rest: null,
    leaders: parseLeaders(comp, home, away),
  };
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
    sports.map(async (sport) => ({
      sport,
      games: (await scoreboard(sport, dateISO)).map((evt) => parseEvent(evt, sport)),
    })),
  );
  const games = boards.flatMap((b) => b.games);

  // ---- Stage 2 (optional): rest intelligence ----
  if (withRest && left() > 2500) {
    try {
      const restBySport = await Promise.all(
        boards.map(async (b) => ({
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
      .filter((g) => g.status === "pre")
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
            g.odds = parseOdds(sum.pickcenter, g.home.abbr, g.away.abbr);
          if (!g.leaders.length && sum.leaders)
            g.leaders = parseLeaders({ leaders: sum.leaders }, g.home, g.away);
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
}

export async function getFinals(
  dateISO: string,
  sport: string,
): Promise<FinalScore[]> {
  const events = await scoreboard(sport, dateISO);
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

const STAT_ALIASES: Record<string, string[]> = {
  PTS: ["PTS"],
  REB: ["REB"],
  AST: ["AST"],
  THREES: ["3PT", "3PM"],
  STL: ["STL"],
  BLK: ["BLK"],
  PASS_YDS: ["YDS"], // resolved within "passing" group
  RUSH_YDS: ["YDS"], // within "rushing"
  REC_YDS: ["YDS"], // within "receiving"
  REC: ["REC"],
  HITS: ["H"],
  GOALS: ["G"],
  SHOTS: ["STOT", "S"],
  STRIKEOUTS: ["SO", "K"],
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
  const wantGroup =
    stat === "PASS_YDS"
      ? "passing"
      : stat === "RUSH_YDS"
        ? "rushing"
        : stat === "REC_YDS" || stat === "REC"
          ? "receiving"
          : null;
  for (const teamBlock of groups) {
    for (const grp of teamBlock?.statistics ?? []) {
      const gname = String(grp?.name ?? "").toLowerCase();
      if (wantGroup && !gname.includes(wantGroup.replace("_yds", ""))) continue;
      const keys: string[] = grp?.keys ?? grp?.labels ?? [];
      for (const ath of grp?.athletes ?? []) {
        const name = normName(ath?.athlete?.displayName ?? "");
        if (!name || (name !== target && !name.includes(target) && !target.includes(name)))
          continue;
        const stats: string[] = ath?.stats ?? [];
        const aliases = STAT_ALIASES[stat] ?? [stat];
        for (const alias of aliases) {
          const i = keys.findIndex((k) => String(k).toUpperCase() === alias);
          if (i >= 0 && stats[i] != null) {
            const n = parseFloat(String(stats[i]).replace(/[^\d.-]/g, ""));
            if (Number.isFinite(n)) return n;
          }
        }
      }
    }
  }
  return null;
}
