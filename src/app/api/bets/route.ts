import { NextRequest } from "next/server";
import { betsToCsv, deleteBet, listBets, setBetResult, upsertBet } from "@/lib/bets";
import { HOUSE, ownerFromRequest } from "@/lib/owner";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Personal bet tracker. Every call is scoped to the caller's private workspace
 * id (x-neonslip-owner). Requests without a real workspace id are refused —
 * they would otherwise all land in the shared "house" workspace.
 */
function ownerOr400(req: NextRequest): string | Response {
  const owner = ownerFromRequest(req);
  if (owner === HOUSE) {
    return Response.json({ error: "A private workspace id is required to track bets." }, { status: 400 });
  }
  return owner;
}

export async function GET(req: NextRequest) {
  const owner = ownerOr400(req);
  if (typeof owner !== "string") return owner;
  try {
    const { bets, summary } = await listBets(owner);
    if (new URL(req.url).searchParams.get("format") === "csv") {
      return new Response(betsToCsv(bets), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="my-bets.csv"',
        },
      });
    }
    return Response.json({ bets, summary });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "could not load bets" }, { status: 500 });
  }
}

/** Log a bet, or edit the stake / price / note of one you already logged. */
export async function POST(req: NextRequest) {
  const owner = ownerOr400(req);
  if (typeof owner !== "string") return owner;
  const body = await req.json().catch(() => null);
  try {
    const res = await upsertBet(owner, body);
    if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
    return Response.json({ bet: res.bet });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "could not save bet" }, { status: 500 });
  }
}

/** Manually settle a bet of yours (voided by the book, took a different line…), or clear it with null. */
export async function PATCH(req: NextRequest) {
  const owner = ownerOr400(req);
  if (typeof owner !== "string") return owner;
  const body = (await req.json().catch(() => null)) as { predictionId?: unknown; result?: unknown } | null;
  const predictionId = Number(body?.predictionId);
  if (!Number.isInteger(predictionId) || predictionId <= 0) {
    return Response.json({ error: "predictionId required" }, { status: 400 });
  }
  try {
    const res = await setBetResult(owner, predictionId, body?.result ?? null);
    if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
    return Response.json({ bet: res.bet });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "could not update bet" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const owner = ownerOr400(req);
  if (typeof owner !== "string") return owner;
  const predictionId = Number(new URL(req.url).searchParams.get("predictionId"));
  if (!Number.isInteger(predictionId) || predictionId <= 0) {
    return Response.json({ error: "predictionId required" }, { status: 400 });
  }
  try {
    const removed = await deleteBet(owner, predictionId);
    return Response.json({ ok: removed });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "could not delete bet" }, { status: 500 });
  }
}
