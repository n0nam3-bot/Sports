import { NextRequest } from "next/server";
import { gradeForecasts, gradePending } from "@/lib/engine";
import { ownerFromRequest } from "@/lib/owner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Settles every pending prediction whose game has gone final, then ripples rating changes through the
// roster. It also grades the forecasts of finished games (the Scoreboard) — that part is best-effort and
// can never get in the way of grading the bets, so the bet summary keeps its top-level shape.
export async function POST(req: NextRequest) {
  try {
    const summary = await gradePending();
    let forecasts = { graded: 0, wins: 0, losses: 0, voided: 0 };
    try {
      forecasts = await gradeForecasts();
    } catch {
      /* the scoreboard catches up on the next sync */
    }
    return Response.json({ ...summary, forecasts });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "grading failed" },
      { status: 500 },
    );
  }
}
