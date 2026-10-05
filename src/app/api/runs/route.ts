import { NextRequest } from "next/server";
import { db } from "@/db";
import { predictions, runs } from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { runPipeline } from "@/lib/engine";
import { ensureSchema } from "@/lib/schema";
import { keysFromRequest, llmEnabledFromRequest } from "@/lib/llm";
import { ownerFromRequest } from "@/lib/owner";

export const dynamic = "force-dynamic";
// Serverless safety: background pipelines are killed on freeze, so on
// function-based platforms we let the cluster finish inside the request.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  await ensureSchema();
  const owner = ownerFromRequest(req);
  const list = await db
    .select()
    .from(runs)
    .where(eq(runs.ownerId, owner))
    .orderBy(desc(runs.id))
    .limit(40);
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

  // Reruns re-select picks that are already staked; show them on that run's
  // card as "carried" so a repeated run never looks empty.
  const carriedIds = [...new Set(list.flatMap((r) => r.carried ?? []))];
  const carriedRows = carriedIds.length
    ? await db
        .select()
        .from(predictions)
        .where(and(eq(predictions.ownerId, owner), inArray(predictions.id, carriedIds)))
    : [];
  const byId = new Map(carriedRows.map((p) => [p.id, p]));

  return Response.json({
    runs: list.map((r) => {
      const fresh = (byRun.get(r.id) ?? []).map((p) => ({ ...p, carried: false }));
      const carried = (r.carried ?? [])
        .map((pid) => byId.get(pid))
        .filter((p): p is (typeof carriedRows)[number] => !!p)
        .map((p) => ({ ...p, carried: true }));
      return {
        ...r,
        predictions: [...fresh, ...carried].sort((a, b) => b.confidence - a.confidence),
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    date?: string;
    sports?: string[];
    markets?: string[];
  } | null;
  if (!body?.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) || !body.sports?.length) {
    return Response.json({ error: "date + sports required" }, { status: 400 });
  }
  await ensureSchema();
  const [run] = await db
    .insert(runs)
    .values({
      ownerId: ownerFromRequest(req),
      slateDate: body.date,
      sports: body.sports.slice(0, 8),
      markets: Array.isArray(body.markets) ? body.markets.slice(0, 20) : [],
      status: "running",
    })
    .returning();
  // Visitor-supplied keys ride along on this one request and are never stored.
  const keys = keysFromRequest(req);
  const llmEnabled = llmEnabledFromRequest(req);
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    // function hosts freeze after the response — run the cluster inline
    await runPipeline(run.id, keys, ownerFromRequest(req), llmEnabled);
  } else {
    // long-lived Node hosts: fire-and-forget, client polls the live trace
    void runPipeline(run.id, keys, ownerFromRequest(req), llmEnabled).catch(() => {});
  }
  return Response.json({ id: run.id });
}
