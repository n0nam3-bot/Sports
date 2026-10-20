import { db } from "@/db";
import { predictions, runs } from "@/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { scrub } from "@/lib/scrub";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const runId = Number(id);
  if (!Number.isFinite(runId)) return Response.json({ error: "bad id" }, { status: 400 });
  const [run] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, runId));
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
        .where(inArray(predictions.id, carriedIds))
    : [];

  const card = [
    ...fresh.map((p) => ({ ...scrub(p), carried: false })),
    ...carried.map((p) => ({ ...scrub(p), carried: true })),
  ].sort((a, b) => (a.carried === b.carried ? a.sortOrder - b.sortOrder : a.carried ? 1 : -1));

  // never serialise the workspace id: it is the owner's only credential
  return Response.json({ run: { ...scrub(run), predictions: card } });
}
