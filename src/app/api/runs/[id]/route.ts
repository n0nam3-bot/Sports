import { db } from "@/db";
import { predictions, runs } from "@/db/schema";
import { asc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const runId = Number(id);
  if (!Number.isFinite(runId)) return Response.json({ error: "bad id" }, { status: 400 });
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return Response.json({ error: "not found" }, { status: 404 });
  const preds = await db
    .select()
    .from(predictions)
    .where(eq(predictions.runId, runId))
    .orderBy(asc(predictions.sortOrder));
  return Response.json({ run: { ...run, predictions: preds } });
}
