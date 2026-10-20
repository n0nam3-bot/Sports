import { db } from "@/db";
import { sql } from "drizzle-orm";
import { configuredProviders, llmEnabledFromRequest } from "@/lib/llm";
import { fetchDiag, getSlateDetailed } from "@/lib/espn";
import { fetchBoutMoneylines, fetchBoutProfiles, fetchFightStatLine } from "@/lib/fighter-stats";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Mobile-friendly self-test: open /api/diag in a browser to see exactly which
// subsystem is failing (database, sports feed, or LLM providers).
export async function GET(req: Request) {
  const report: Record<string, unknown> = {
    time: new Date().toISOString(),
    host: process.env.VERCEL ? "vercel" : "node",
    region: process.env.VERCEL_REGION ?? "local",
  };

  // 1. database
  try {
    await db.execute(sql`select 1`);
    report.database = { ok: true, urlConfigured: !!process.env.DATABASE_URL };
  } catch (e) {
    report.database = {
      ok: false,
      urlConfigured: !!process.env.DATABASE_URL,
      error: e instanceof Error ? e.message : "unknown",
      hint: "Set DATABASE_URL in your host's environment variables, then redeploy.",
    };
  }

  // 2. sports feed — probe today and the next two days across two leagues
  const probe: Record<string, unknown>[] = [];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  for (const offset of [0, 1, 2]) {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    const iso = d.toISOString().slice(0, 10);
    try {
      const { games, elapsedMs } = await getSlateDetailed(iso, ["nfl", "nba", "nhl", "mlb", "ncaaf"], {
        budgetMs: 7000,
        withRest: false,
        withInjuries: false,
      });
      probe.push({
        date: iso,
        games: games.length,
        pre: games.filter((g) => g.status === "pre").length,
        sample: games.slice(0, 3).map((g) => `${g.sportLabel} ${g.matchup} (${g.status})`),
        ms: elapsedMs,
      });
    } catch (e) {
      probe.push({ date: iso, error: e instanceof Error ? e.message : "failed" });
    }
  }
  report.sportsFeed = {
    ok: probe.some((p) => typeof p.games === "number" && (p.games as number) > 0),
    upstream: "site.api.espn.com",
    lastRequest: fetchDiag,
    probe,
    hint: "If every probe returns 0 games, the host cannot reach ESPN. If some dates have games, just pick one of those dates.",
  };

  // 3. MMA data path — the part that cannot be checked from outside a live deployment.
  // Finds the nearest UFC / DWCS / PFL bout and reports exactly which ESPN endpoints answer.
  try {
    let found: { date: string; g: Awaited<ReturnType<typeof getSlateDetailed>>["games"][number] } | null = null;
    for (const offset of [0, 1, 2, 3, 4, 5, 6]) {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + offset);
      const iso = d.toISOString().slice(0, 10);
      const { games } = await getSlateDetailed(iso, ["ufc", "dwcs", "pfl"], { budgetMs: 5000, withRest: false, withInjuries: false });
      const g = games.find((x) => x.combat);
      if (g) {
        found = { date: iso, g };
        break;
      }
    }
    if (!found) {
      report.mma = { ok: null, note: "No UFC / DWCS / PFL bouts in the next 7 days — nothing to probe. (Not an error.)" };
    } else {
      const c = found.g.combat!;
      const league = c.league as "ufc" | "pfl";
      const { away, home, ids } = await fetchBoutProfiles(c.eventId, c.competitionId, league);
      const ml = await fetchBoutMoneylines(league, c.eventId, c.competitionId, ids.away, ids.home);
      // Post-fight stats only exist for finished bouts, so this checks the endpoint answers at all.
      const stat = ids.away ? await fetchFightStatLine(league, c.eventId, c.competitionId, ids.away) : null;
      report.mma = {
        ok: !!(away?.hasStats && home?.hasStats),
        bout: `${found.g.matchup} (${found.g.sportLabel}, ${found.date})`,
        fighterIds: ids,
        careerStats: {
          away: away ? { name: away.displayName, loaded: away.hasStats, slpm: away.strikeLPM, tdPer15: away.takedownAvg } : null,
          home: home ? { name: home.displayName, loaded: home.hasStats, slpm: home.strikeLPM, tdPer15: home.takedownAvg } : null,
        },
        espnMoneyline: ml ?? "not published — MMA picks are model-priced (they state a price floor)",
        postFightStatsEndpoint: stat ? "answers" : "no data yet (normal before the fight; needed to grade sig-strikes/takedown picks)",
        hint: away?.hasStats && home?.hasStats
          ? "Fighter career stats load: strikes, takedown, method and round markets are enabled."
          : "Fighter career stats did NOT load, so MMA falls back to records only: no sig-strike/takedown/method/spread picks and a stricter bar. Check fetchLastRequest and ESPN's athlete statistics endpoint from this host.",
      };
    }
  } catch (e) {
    report.mma = { ok: false, error: e instanceof Error ? e.message : "failed" };
  }

  // 4. LLM providers (entirely optional)
  const providers = configuredProviders({}, llmEnabledFromRequest(req));
  report.llm = {
    configured: providers.length,
    providers: providers.map((p) => p.label),
    note:
      providers.length === 0
        ? "No API keys set — running the built-in quantitative core. This is fully supported and free; keys are optional."
        : "LLM swarm active.",
  };

  return Response.json(report);
}
