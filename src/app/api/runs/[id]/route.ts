import { db } from "@/db";
import { predictions, runs } from "@/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { ownerFromRequest } from "@/lib/owner";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const runId = Number(id);
  if (!Number.isFinite(runId)) return Response.json({ error: "bad id" }, { status: 400 });
  const owner = ownerFromRequest(req);
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.ownerId, owner)));
  if (!run) return Response.json({ error: "not found" }, { status: 404 });

  const fresh = await db
    .select()
    .from(predictions)
    .where(eq(predictions.runId, runId))
    .orderBy(asc(predictions.sortOrder));

  // Picks re-selected by this run that were already staked earlier still
  // belong on this card — they're just graded once, on their original run.
  const carriedIds = run.carried ?? [];
  const carried = carriedIds.length
    ? await db
        .select()
        .from(predictions)
        .where(and(eq(predictions.ownerId, owner), inArray(predictions.id, carriedIds)))
    : [];

  const card = [
    ...fresh.map((p) => ({ ...p, carried: false })),
    ...carried.map((p) => ({ ...p, carried: true })),
  ].sort((a, b) => b.confidence - a.confidence);

  return Response.json({ run: { ...run, predictions: card } });
}
