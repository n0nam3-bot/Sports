import { NextRequest } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { forecasts } from "@/db/schema";
import { SPORT_PATHS } from "@/lib/espn";
import { ensureSchema } from "@/lib/schema";

export const dynamic = "force-dynamic";

// A prediction for every game on a slate (see src/lib/forecast.ts): our win probability for the side we
// favour, next to the vig-free market's. Public and read-only, like the ledger. A forecast is NOT a bet —
// nothing here carries a stake.
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
    await ensureSchema();
    const rows = await db
      .select()
      .from(forecasts)
      .where(and(eq(forecasts.slateDate, date), inArray(forecasts.sport, sports)))
      .orderBy(asc(forecasts.startTime), asc(forecasts.id));
    return Response.json({
      date,
      sports,
      forecasts: rows.map((f) => ({
        id: f.id,
        sport: f.sport,
        eventId: f.eventId,
        matchup: f.matchup,
        startTime: f.startTime.toISOString(),
        pick: f.pick,
        side: f.side,
        pModel: f.pModel,
        pMarket: f.pMarket,
        note: f.note,
        outcome: f.outcome,
        finalScore: f.finalScore,
      })),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "could not load forecasts" }, { status: 500 });
  }
}
