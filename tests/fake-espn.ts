/**
 * A fake ESPN, installed over global fetch. It serves payloads shaped exactly
 * like the ones src/lib/espn.ts and fighter-stats.ts parse, so the REAL parsing
 * code runs in the integration tests.
 */

export interface FakeState {
  /** the slate date (ET) being analysed */
  date: string;
  phase: "pre" | "final";
  /** serve fighter career stats from the core API */
  fighterStats: boolean;
  /** serve a real moneyline for the lopsided bout */
  mmaMoneyline: boolean;
  /** serve post-fight statistics (sig strikes / takedowns) */
  fightStats: boolean;
  /** event ids whose per-game summary 404s (injury report "never fetched") */
  failSummary: Set<string>;
  /** every URL requested, for assertions */
  log: string[];
  /** plays the LLM provider (OpenRouter). Return the model's text, or null to fail the call. */
  llm?: (req: { system: string; user: string }) => string | null;
  /** every LLM request seen */
  llmCalls: { system: string; user: string }[];
}

export function newState(date: string): FakeState {
  return {
    date,
    phase: "pre",
    fighterStats: true,
    mmaMoneyline: false,
    fightStats: true,
    failSummary: new Set(["401003"]),
    log: [],
    llmCalls: [],
  };
}

const prevDay = (iso: string): string => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const ml = (n: number) => ({ close: { odds: n > 0 ? `+${n}` : String(n) } });

function odds(home: string, spread: number, total: number, homeML: number, awayML: number) {
  return [
    {
      provider: { name: "DraftKings" },
      details: `${home} ${spread}`,
      spread,
      overUnder: total,
      moneyline: { home: ml(homeML), away: ml(awayML) },
      pointSpread: { home: ml(-110), away: ml(-110) },
      total: { over: { close: { odds: "-110", line: `o${total}` } }, under: { close: { odds: "-110" } } },
    },
  ];
}

interface TeamSpec {
  id: string;
  abbr: string;
  name: string;
  total: string;
}

function nbaEvent(
  id: string,
  home: TeamSpec,
  away: TeamSpec,
  date: string,
  odd: unknown,
  final?: { home: number; away: number; homeLine: number[]; awayLine: number[] },
) {
  const state = final ? "post" : "pre";
  const comp = (t: TeamSpec, side: "home" | "away") => ({
    homeAway: side,
    team: { id: t.id, abbreviation: t.abbr, displayName: t.name },
    records: [
      { type: "total", summary: t.total },
      { type: "home", summary: "10-5" },
      { type: "road", summary: "8-7" },
    ],
    score: final ? String(final[side]) : undefined,
    linescores: final ? (side === "home" ? final.homeLine : final.awayLine).map((v) => ({ value: v })) : undefined,
    probables: [],
  });
  return {
    id,
    name: `${away.name} at ${home.name}`,
    date: `${date}T23:30:00Z`,
    status: { type: { state, completed: !!final, shortDetail: final ? "Final" : "7:30 PM ET" } },
    competitions: [
      {
        competitors: [comp(home, "home"), comp(away, "away")],
        odds: odd,
        leaders: [
          {
            name: "pointsPerGame",
            leaders: [
              { athlete: { displayName: "Star Guard", team: { id: "18" }, position: { abbreviation: "G" } }, value: 27.5 },
              { athlete: { displayName: "Home Wing", team: { id: "2" }, position: { abbreviation: "F" } }, value: 24.1 },
            ],
          },
        ],
      },
    ],
  };
}

const BOS: TeamSpec = { id: "2", abbr: "BOS", name: "Boston Celtics", total: "30-10" };
const NYK: TeamSpec = { id: "18", abbr: "NYK", name: "New York Knicks", total: "22-18" };
const LAL: TeamSpec = { id: "13", abbr: "LAL", name: "Los Angeles Lakers", total: "20-20" };
const DEN: TeamSpec = { id: "7", abbr: "DEN", name: "Denver Nuggets", total: "20-20" };
const MIA: TeamSpec = { id: "14", abbr: "MIA", name: "Miami Heat", total: "20-20" };
const CHI: TeamSpec = { id: "4", abbr: "CHI", name: "Chicago Bulls", total: "20-20" };
const WAS: TeamSpec = { id: "27", abbr: "WAS", name: "Washington Wizards", total: "10-30" };

function nbaBoard(s: FakeState) {
  const fin = s.phase === "final";
  return [
    // E1: BOS (-4.5) host a NYK team on the second night of a back-to-back, missing two players,
    // while ESPN's own projection likes BOS far more than the market does.
    nbaEvent("401001", BOS, NYK, s.date, odds("BOS", -4.5, 221.5, -190, 160),
      fin ? { home: 112, away: 101, homeLine: [30, 28, 27, 27], awayLine: [25, 24, 26, 26] } : undefined),
    // E2: a fair board with no situational edge at all.
    nbaEvent("401002", LAL, DEN, s.date, odds("LAL", -1.5, 228.5, -125, 105),
      fin ? { home: 110, away: 108, homeLine: [28, 27, 28, 27], awayLine: [27, 27, 27, 27] } : undefined),
    // E3: the per-game summary will 404, so injuries were never checked.
    nbaEvent("401003", MIA, CHI, s.date, odds("MIA", -6.5, 215.5, -270, 220),
      fin ? { home: 100, away: 90, homeLine: [25, 25, 25, 25], awayLine: [22, 22, 23, 23] } : undefined),
  ];
}

function nbaPrevDay(s: FakeState) {
  // NYK played last night → back-to-back tonight
  return [
    nbaEvent("400900", WAS, NYK, prevDay(s.date), odds("WAS", 5.5, 220.5, 190, -230),
      { home: 98, away: 104, homeLine: [25, 25, 24, 24], awayLine: [26, 26, 26, 26] }),
  ];
}

function summaryFor(id: string, s: FakeState) {
  if (s.failSummary.has(id)) return null;
  if (id === "401001") {
    return {
      injuries: [
        {
          team: { abbreviation: "NYK" },
          injuries: [
            { athlete: { displayName: "Star Guard" }, status: "Out", details: { type: "Knee" } },
            { athlete: { displayName: "Starting Big" }, status: "Out", details: { type: "Ankle" } },
          ],
        },
      ],
      predictor: { homeTeam: { gameProjection: "78.0" }, awayTeam: { gameProjection: "22.0" } },
      boxscore: { players: [] },
    };
  }
  return { injuries: [], boxscore: { players: [] } };
}

// ---------------------------------------------------------------------------
// MMA
// ---------------------------------------------------------------------------
interface BoutSpec {
  id: string;
  weight: string;
  rounds: number;
  away: { id: string; name: string; record: string };
  home: { id: string; name: string; record: string };
}

const B1: BoutSpec = {
  id: "B1", weight: "Heavyweight", rounds: 5,
  away: { id: "4001001", name: "Away Fighter", record: "22-3-0" },
  home: { id: "4001002", name: "Home Fighter", record: "11-6-0" },
};
const B2: BoutSpec = {
  id: "B2", weight: "Lightweight", rounds: 3,
  away: { id: "4002001", name: "Even Alpha", record: "15-4-0" },
  home: { id: "4002002", name: "Even Bravo", record: "15-4-0" },
};
const B3: BoutSpec = {
  id: "B3", weight: "Welterweight", rounds: 3,
  away: { id: "4003001", name: "Prospect One", record: "5-0-0" },
  home: { id: "4003002", name: "Prospect Two", record: "6-1-0" },
};

function boutJson(b: BoutSpec, s: FakeState, result?: { winner: "away" | "home"; round: number; clock: string; text: string }) {
  const fin = s.phase === "final" && result;
  return {
    id: b.id,
    date: `${s.date}T17:00:00Z`,
    type: { abbreviation: b.weight },
    format: { regulation: { periods: b.rounds } },
    status: {
      type: { state: fin ? "post" : "pre", completed: !!fin, detail: fin ? "Final" : "Scheduled", description: fin ? "Final" : "Scheduled" },
      period: fin ? result!.round : 0,
      displayClock: fin ? result!.clock : "0:00",
      result: fin ? { name: result!.text, description: result!.text, displayName: result!.text } : undefined,
    },
    competitors: [b.away, b.home].map((f, i) => ({
      id: f.id,
      athlete: { id: f.id, displayName: f.name },
      records: [{ summary: f.record }],
      winner: fin ? (result!.winner === (i === 0 ? "away" : "home")) : undefined,
    })),
  };
}

function mmaBoard(s: FakeState, sport: "ufc" | "pfl") {
  if (sport === "pfl") return [];
  return [
    {
      id: "CARD1",
      name: "UFC Fight Night: Test Card",
      shortName: "UFC FN",
      date: `${s.date}T17:00:00Z`,
      competitions: [
        boutJson(B1, s, { winner: "away", round: 2, clock: "3:15", text: "KO/TKO" }),
        boutJson(B2, s, { winner: "home", round: 3, clock: "5:00", text: "Decision - Unanimous" }),
      ],
    },
    {
      id: "CARD2",
      name: "Dana White's Contender Series: Week 1",
      shortName: "DWCS",
      date: `${s.date}T17:00:00Z`,
      competitions: [boutJson(B3, s, { winner: "away", round: 1, clock: "1:20", text: "Submission" })],
    },
  ];
}

const FIGHTERS: Record<string, { stats: Record<string, number>; stance: string }> = {
  4001001: { stance: "Orthodox", stats: { strikeLPM: 5.6, strikeAccuracy: 48, strikeDefense: 55, takedownAvg: 0.4, takedownAccuracy: 30, takedownDefense: 62, submissionAvg: 0.2, koPercentage: 50, tkoPercentage: 22, decisionPercentage: 8 } },
  4001002: { stance: "Southpaw", stats: { strikeLPM: 3.0, strikeAccuracy: 40, strikeDefense: 42, takedownAvg: 0.8, takedownAccuracy: 35, takedownDefense: 48, submissionAvg: 0.3, koPercentage: 20, tkoPercentage: 10, decisionPercentage: 30 } },
  4002001: { stance: "Orthodox", stats: { strikeLPM: 3.4, strikeAccuracy: 45, strikeDefense: 55, takedownAvg: 0.9, takedownAccuracy: 40, takedownDefense: 62, submissionAvg: 0.5, koPercentage: 20, tkoPercentage: 15, decisionPercentage: 30 } },
  4002002: { stance: "Orthodox", stats: { strikeLPM: 3.4, strikeAccuracy: 45, strikeDefense: 55, takedownAvg: 0.9, takedownAccuracy: 40, takedownDefense: 62, submissionAvg: 0.5, koPercentage: 20, tkoPercentage: 15, decisionPercentage: 30 } },
  4003001: { stance: "Orthodox", stats: { strikeLPM: 3.4, strikeAccuracy: 45, strikeDefense: 55, takedownAvg: 0.9, takedownAccuracy: 40, takedownDefense: 62, submissionAvg: 0.5, koPercentage: 20, tkoPercentage: 15, decisionPercentage: 30 } },
  4003002: { stance: "Orthodox", stats: { strikeLPM: 3.4, strikeAccuracy: 45, strikeDefense: 55, takedownAvg: 0.9, takedownAccuracy: 40, takedownDefense: 62, submissionAvg: 0.5, koPercentage: 20, tkoPercentage: 15, decisionPercentage: 30 } },
};

/** Post-fight per-competitor statistics, in the nested shape ESPN's core API uses. */
const FIGHT_STATS: Record<string, { sig: number; td: number }> = {
  4001001: { sig: 61, td: 0 },
  4001002: { sig: 22, td: 1 },
  4002001: { sig: 70, td: 2 },
  4002002: { sig: 88, td: 1 },
};

const CORE = "https://sports.core.api.espn.com/v2/sports/mma";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function installFakeEspn(state: FakeState): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    state.log.push(url);
    const u = new URL(url);

    // ------------- LLM provider -------------
    if (u.hostname === "openrouter.ai") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { role: string; content: string }[] };
      const system = body.messages?.find((m) => m.role === "system")?.content ?? "";
      const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
      state.llmCalls.push({ system, user });
      const text = state.llm ? state.llm({ system, user }) : null;
      if (text == null) return json({ error: "boom" }, 500);
      return json({ choices: [{ message: { content: text } }] });
    }

    // ------------- site API -------------
    if (u.hostname === "site.api.espn.com") {
      const m = u.pathname.match(/\/sports\/(.+?)\/(scoreboard|summary)$/);
      if (!m) return json({}, 404);
      const [, path, kind] = m;
      if (kind === "scoreboard") {
        const ymd = u.searchParams.get("dates") ?? "";
        const today = state.date.replaceAll("-", "");
        const yday = prevDay(state.date).replaceAll("-", "");
        if (path === "basketball/nba") {
          if (ymd === today) return json({ events: nbaBoard(state) });
          if (ymd === yday) return json({ events: nbaPrevDay(state) });
          return json({ events: [] });
        }
        if (path === "mma/ufc" && ymd === today) return json({ events: mmaBoard(state, "ufc") });
        if (path === "mma/pfl") return json({ events: [] });
        return json({ events: [] });
      }
      // summary
      const id = u.searchParams.get("event") ?? "";
      const s = summaryFor(id, state);
      return s ? json(s) : json({}, 404);
    }

    // ------------- core API (MMA) -------------
    if (u.hostname === "sports.core.api.espn.com") {
      const p = u.pathname.replace("/v2/sports/mma", "");
      // competitor list for a bout
      let mm = p.match(/^\/leagues\/(ufc|pfl)\/events\/(\w+)\/competitions\/(\w+)\/competitors$/);
      if (mm) {
        const bout = [B1, B2, B3].find((b) => b.id === mm![3]);
        if (!bout) return json({}, 404);
        return json({
          items: [bout.away, bout.home].map((f) => ({ $ref: `${CORE}/leagues/${mm![1]}/events/${mm![2]}/competitions/${mm![3]}/competitors/${f.id}?lang=en&region=us` })),
        });
      }
      // a single competitor → athlete ref
      mm = p.match(/^\/leagues\/(ufc|pfl)\/events\/(\w+)\/competitions\/(\w+)\/competitors\/(\w+)$/);
      if (mm) return json({ athlete: { $ref: `${CORE}/athletes/${mm[4]}?lang=en&region=us` } });
      // post-fight statistics for a competitor
      mm = p.match(/^\/leagues\/(ufc|pfl)\/events\/(\w+)\/competitions\/(\w+)\/competitors\/(\w+)\/statistics$/);
      if (mm) {
        if (!state.fightStats) return json({}, 404);
        const fs = FIGHT_STATS[mm[4]];
        if (!fs) return json({}, 404);
        return json({
          splits: {
            categories: [
              { name: "striking", stats: [{ name: "sigStrikesLanded", displayName: "Sig. Strikes Landed", value: fs.sig }, { name: "sigStrikesAttempted", value: fs.sig * 2 }, { name: "sigStrikeAccuracy", value: 50 }] },
              { name: "grappling", stats: [{ name: "takedownsLanded", value: fs.td }, { name: "takedownsAttempted", value: fs.td + 2 }] },
            ],
          },
        });
      }
      // bout odds
      mm = p.match(/^\/leagues\/(ufc|pfl)\/events\/(\w+)\/competitions\/(\w+)\/odds$/);
      if (mm) {
        if (!(state.mmaMoneyline && mm[3] === "B1")) return json({ items: [] });
        return json({
          items: [
            {
              awayAthleteOdds: { athlete: { $ref: `${CORE}/athletes/4001001` }, moneyLine: -290 },
              homeAthleteOdds: { athlete: { $ref: `${CORE}/athletes/4001002` }, moneyLine: 240 },
            },
          ],
        });
      }
      // career stats
      mm = p.match(/^\/(?:leagues\/(?:ufc|pfl)\/)?athletes\/(\w+)\/statistics$/);
      if (mm) {
        const f = FIGHTERS[mm[1]];
        if (!f || !state.fighterStats) return json({}, 404);
        return json({
          splits: { categories: [{ name: "general", stats: Object.entries(f.stats).map(([name, value]) => ({ name, value })) }] },
        });
      }
      // athlete bio
      mm = p.match(/^\/athletes\/(\w+)$/);
      if (mm) {
        const f = FIGHTERS[mm[1]];
        if (!f) return json({}, 404);
        return json({ displayName: mm[1], stance: { text: f.stance }, reach: 74, height: 75 });
      }
    }
    return json({}, 404);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
