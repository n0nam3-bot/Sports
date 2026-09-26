import { NextRequest } from "next/server";
import { cachedSlate } from "@/lib/engine";
import { configuredProviders } from "@/lib/llm";
import { SPORT_PATHS } from "@/lib/espn";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? "";
  const sports = (url.searchParams.get("sports") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => SPORT_PATHS[s]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !sports.length) {
    return Response.json({ error: "date + sports required" }, { status: 400 });
  }
  const games = await cachedSlate(date, sports);
  return Response.json({
    date,
    sports,
    games,
    providers: configuredProviders().map((p) => p.label),
    counts: {
      total: games.length,
      pre: games.filter((g) => g.status === "pre").length,
      live: games.filter((g) => g.status === "in").length,
      final: games.filter((g) => g.status === "post").length,
    },
  });
}
