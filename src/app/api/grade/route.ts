import { NextRequest } from "next/server";
import { gradePending } from "@/lib/engine";
import { ownerFromRequest } from "@/lib/owner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Settles every pending prediction whose game has gone final,
// then ripples rating changes + self-improvement through the roster.
export async function POST(req: NextRequest) {
  try {
    const summary = await gradePending(ownerFromRequest(req));
    return Response.json(summary);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "grading failed" },
      { status: 500 },
    );
  }
}
