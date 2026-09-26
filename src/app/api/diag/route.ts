import { db } from "@/db";
import { sql } from "drizzle-orm";
import { configuredProviders } from "@/lib/llm";
import { fetchDiag, getSlateDetailed } from "@/lib/espn";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Mobile-friendly self-test: open /api/diag in a browser to see exactly which
// subsystem is failing (database, sports feed, or LLM providers).
export async function GET() {
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

  // 3. LLM providers (entirely optional)
  const providers = configuredProviders();
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
