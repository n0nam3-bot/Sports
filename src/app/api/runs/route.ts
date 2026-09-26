import { NextRequest } from "next/server";
import { db } from "@/db";
import { predictions, runs } from "@/db/schema";
import { desc, inArray } from "drizzle-orm";
import { runPipeline } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const list = await db.select().from(runs).orderBy(desc(runs.id)).limit(40);
  const ids = list.map((r) => r.id);
  const preds = ids.length
    ? await db.select().from(predictions).where(inArray(predictions.runId, ids))
    : [];
  const byRun = new Map<number, typeof preds>();
  for (const p of preds) {
    const arr = byRun.get(p.runId) ?? [];
    arr.push(p);
    byRun.set(p.runId, arr);
  }
  for (const arr of byRun.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder);
  return Response.json({
    runs: list.map((r) => ({ ...r, predictions: byRun.get(r.id) ?? [] })),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    date?: string;
    sports?: string[];
  } | null;
  if (!body?.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) || !body.sports?.length) {
    return Response.json({ error: "date + sports required" }, { status: 400 });
  }
  const [run] = await db
    .insert(runs)
    .values({ slateDate: body.date, sports: body.sports.slice(0, 6), status: "running" })
    .returning();
  // fire-and-forget: the client polls /api/runs/[id] for the live trace
  void runPipeline(run.id).catch(() => {});
  return Response.json({ id: run.id });
}
