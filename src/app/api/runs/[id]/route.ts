import { db } from "@/db";
import { predictions, runs } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
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
  const preds = await db
    .select()
    .from(predictions)
    .where(eq(predictions.runId, runId))
    .orderBy(asc(predictions.sortOrder));
  return Response.json({ run: { ...run, predictions: preds } });
}
