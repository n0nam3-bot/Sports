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
  homeML: number | null;
  awayML: number | null;
  overUnder: number | null;
  overOdds: number | null;
  underOdds: number | null;
  homeTeamTotal: number | null;
  awayTeamTotal: number | null;
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

async function jfetch(url: string, timeoutMs = 12000): Promise<any | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { "user-agent": "neonslip-agent/1.0" },
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
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

export function parseOdds(raw: any): OddsInfo | null {
  const o = Array.isArray(raw) ? raw[0] : raw;
  if (!o) return null;
  let homeSpread: number | null = null;
  const spread = typeof o.spread === "number" ? o.spread : null;
  if (spread != null) {
    if (o.homeTeamOdds?.favorite) homeSpread = -Math.abs(spread);
    else if (o.awayTeamOdds?.favorite) homeSpread = Math.abs(spread);
  }
  return {
    provider: o.provider?.name ?? "ESPN BET",
    details: o.details ?? "",
    homeSpread,
    homeML: o.homeTeamOdds?.moneyLine ?? null,
    awayML: o.awayTeamOdds?.moneyLine ?? null,
    overUnder: typeof o.overUnder === "number" ? o.overUnder : null,
    overOdds: o.overOdds ?? null,
    underOdds: o.underOdds ?? null,
    homeTeamTotal: o.homeTeamOdds?.total ?? null,
    awayTeamTotal: o.awayTeamOdds?.total ?? null,
  };
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
    odds: parseOdds(comp.odds),
    injuries: [],
    rest: null,
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
  const out: TeamDay[] = [];
  for (let i = 1; i <= back; i++) {
    const events = await scoreboard(sport, addDays(dateISO, -i));
    const abbrs = new Set<string>();
    const homeAbbrs = new Set<string>();
    for (const evt of events) {
      const g = parseEvent(evt, sport);
      abbrs.add(g.home.abbr);
      abbrs.add(g.away.abbr);
      homeAbbrs.add(g.home.abbr);
    }
    out.push({ abbrs, homeAbbrs });
  }
  return out;
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

export async function getSlate(dateISO: string, sports: string[]): Promise<GameInfo[]> {
  const perSport = await Promise.all(
    sports.map(async (sport) => {
      const [events, days] = await Promise.all([
        scoreboard(sport, dateISO),
        teamDaysBack(sport, dateISO, 3),
      ]);
      const games = events.map((evt) => parseEvent(evt, sport));
      for (const g of games) {
        g.rest = computeRest(g.home.abbr, g.away.abbr, days);
      }
      // Injuries only matter for upcoming analysis; enrich pre-games.
      await mapLimit(
        games.filter((g) => g.status !== "post"),
        6,
        async (g) => {
          const sum = await summary(sport, g.eventId);
          if (sum) {
            g.injuries = parseInjuries(sum);
            if (!g.odds && sum.pickcenter) g.odds = parseOdds(sum.pickcenter);
          }
          return g;
        },
      );
      return games;
    }),
  );
  return perSport
    .flat()
    .sort(
      (a, b) =>
        new Date(a.startTime || 0).getTime() - new Date(b.startTime || 0).getTime(),
    );
}

// ---------- finals for grading ----------

export interface FinalScore {
  eventId: string;
  status: "pre" | "in" | "post";
  homeAbbr: string;
  awayAbbr: string;
  homeScore: number;
  awayScore: number;
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
    return {
      eventId: String(evt.id),
      status: st.state === "in" ? "in" : st.completed || st.state === "post" ? "post" : "pre",
      homeAbbr: home?.team?.abbreviation ?? "?",
      awayAbbr: away?.team?.abbreviation ?? "?",
      homeScore: Number(home?.score ?? 0),
      awayScore: Number(away?.score ?? 0),
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
