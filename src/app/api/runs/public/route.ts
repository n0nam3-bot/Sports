/**
 * Public prediction feed — returns completed runs visible to all visitors.
 *
 * When the site owner posts a run as public, every visitor can see it.
 * Visitors can also start their own anonymous runs (they get their workspace
 * run). The public endpoint merges the two for the Prediction Ledger.
 *
 * Cross-run deduplication is applied so inflating W/L counts is impossible.
 */
import { NextRequest } from "next/server";
import { db } from "@/db";
import { predictions, runs } from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ensureSchema } from "@/lib/schema";
import { ownerFromRequest } from "@/lib/owner";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  await ensureSchema();

  const publicRuns = await db
    .select()
    .from(runs)
    .where(and(eq(runs.isPublic, 1), eq(runs.status, "completed")))
    .orderBy(desc(runs.id))
    .limit(20);

  if (!publicRuns.length) return Response.json({ runs: [] });

  const ids = publicRuns.map((r) => r.id);
  const preds = await db
    .select()
    .from(predictions)
    .where(inArray(predictions.runId, ids));

  // Build a map of dedupe keys → earliest run that holds the canonical result.
  const canonicalByKey = new Map<string, typeof preds[number]>();
  for (const p of [...preds].sort((a, b) => a.id - b.id)) {
    if (!canonicalByKey.has(p.dedupeKey)) canonicalByKey.set(p.dedupeKey, p);
  }

  const byRun = new Map<number, typeof preds>();
  for (const p of preds) {
    const arr = byRun.get(p.runId) ?? [];
    arr.push(p);
    byRun.set(p.runId, arr);
  }

  const viewer = ownerFromRequest(req);

  return Response.json({
    runs: publicRuns.map((r) => {
      const raw = byRun.get(r.id) ?? [];
      const predictions_annotated = raw
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((p) => {
          const canon = canonicalByKey.get(p.dedupeKey);
          const isDuplicate = canon && canon.id !== p.id;
          const canonRunId = isDuplicate ? canon!.runId : null;
          return {
            ...p,
            isDuplicate,
            canonRunId,
            // Use the canonical outcome for display even on duplicate rows —
            // this prevents empty outcomes on clone rows in the UI.
            outcome: isDuplicate && canon ? canon.outcome : p.outcome,
            finalScore: isDuplicate && canon ? canon.finalScore : p.finalScore,
          };
        });
      return {
        ...r,
        predictions: predictions_annotated,
        isViewerRun: r.ownerId === viewer,
      };
    }),
  });
}

/** Site owner marks one of their runs as public for the shared feed. */
export async function POST(req: NextRequest) {
  await ensureSchema();
  const body = await req.json().catch(() => null) as { runId?: number; public?: boolean } | null;
  if (!body?.runId) return Response.json({ error: "runId required" }, { status: 400 });

  const viewer = ownerFromRequest(req);
  const [run] = await db.select().from(runs).where(eq(runs.id, body.runId));
  if (!run) return Response.json({ error: "not found" }, { status: 404 });
  if (run.ownerId !== viewer)
    return Response.json({ error: "not your run" }, { status: 403 });

  await db
    .update(runs)
    .set({ isPublic: body.public !== false ? 1 : 0 })
    .where(eq(runs.id, body.runId));
  return Response.json({ ok: true });
}
