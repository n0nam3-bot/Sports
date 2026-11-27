import { desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { forecasts } from "@/db/schema";
import { scoreForecasts } from "@/lib/forecast";
import { ensureSchema } from "@/lib/schema";

export const dynamic = "force-dynamic";

// How good are the forecasts? Every graded forecast (not just the ones we bet), scored by Brier and set
// against the vig-free market on the SAME games, with a standard error — so "we beat the market" is only
// ever claimed when the numbers support it. Public and read-only.
export async function GET() {
  try {
    await ensureSchema();
    const graded = await db
      .select()
      .from(forecasts)
      .where(sql`${forecasts.outcome} in ('win', 'loss') and ${gte(forecasts.engineVersion, 5)}`)
      .orderBy(desc(forecasts.id))
      .limit(5000);
    const [pend] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(forecasts)
      .where(eq(forecasts.outcome, "pending"));

    const board = scoreForecasts(
      graded.map((r) => ({ sport: r.sport, pModel: r.pModel, pMarket: r.pMarket, outcome: r.outcome === "win" ? ("win" as const) : ("loss" as const) })),
    );
    return Response.json({
      asOf: new Date().toISOString(),
      /** the earliest game in the scored window */
      since: graded.length ? graded.reduce((m, r) => (r.slateDate < m ? r.slateDate : m), graded[0].slateDate) : null,
      pending: pend?.n ?? 0,
      ...board,
      /** the last results, newest first — so the numbers can be checked against real games */
      recent: graded.slice(0, 12).map((r) => ({
        slateDate: r.slateDate,
        sport: r.sport,
        matchup: r.matchup,
        pick: r.pick,
        pModel: r.pModel,
        pMarket: r.pMarket,
        outcome: r.outcome,
        finalScore: r.finalScore,
      })),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "could not load the scoreboard" }, { status: 500 });
  }
}
