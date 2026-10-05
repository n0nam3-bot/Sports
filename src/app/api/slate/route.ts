import { NextRequest } from "next/server";
import { cachedSlate } from "@/lib/engine";
import { configuredProviders, keysFromRequest, llmEnabledFromRequest } from "@/lib/llm";
import { SPORT_PATHS } from "@/lib/espn";

export const dynamic = "force-dynamic";
// Hobby-tier functions default to 10s; the slate needs room to enrich.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? "";
  const sports = (url.searchParams.get("sports") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => SPORT_PATHS[s]);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "invalid date (expected YYYY-MM-DD)" }, { status: 400 });
  }
  if (!sports.length) {
    return Response.json({ error: "select at least one sport" }, { status: 400 });
  }

  try {
    const { games, degraded } = await cachedSlate(date, sports);
    return Response.json({
      date,
      sports,
      games,
      degraded,
      providers: configuredProviders(keysFromRequest(req), llmEnabledFromRequest(req)).map((p) => p.label),
      counts: {
        total: games.length,
        pre: games.filter((g) => g.status === "pre").length,
        live: games.filter((g) => g.status === "in").length,
        final: games.filter((g) => g.status === "post").length,
      },
    });
  } catch (e) {
    return Response.json(
      {
        error: e instanceof Error ? e.message : "slate fetch failed",
        hint: "The upstream sports feed did not respond. Retry, or try fewer sports at once.",
      },
      { status: 502 },
    );
  }
}
