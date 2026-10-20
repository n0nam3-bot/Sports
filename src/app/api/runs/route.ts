import { NextRequest } from "next/server";
import { db } from "@/db";
import { predictions, runs } from "@/db/schema";
import { desc, inArray } from "drizzle-orm";
import { runPipeline } from "@/lib/engine";
import { disciplineOf } from "@/lib/discipline";
import { SPORT_PATHS } from "@/lib/espn";
import { ensureSchema } from "@/lib/schema";
import { keysFromRequest, llmEnabledFromRequest } from "@/lib/llm";
import { ownerFromRequest, adminOwnerId } from "@/lib/owner";
import { scrub } from "@/lib/scrub";

export const dynamic = "force-dynamic";
// Serverless safety: background pipelines are killed on freeze, so on
// function-based platforms we let the cluster finish inside the request.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  await ensureSchema();
    const list = await db
    .select()
    .from(runs)
    .orderBy(desc(runs.id))
    .limit(50);
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
        .where(inArray(predictions.id, carriedIds))
    : [];
  const byId = new Map(carriedRows.map((p) => [p.id, p]));

  return Response.json({
    runs: list.map((r) => {
      const fresh = (byRun.get(r.id) ?? []).map((p) => ({ ...scrub(p), carried: false }));
      const carried = (r.carried ?? [])
        .map((pid) => byId.get(pid))
        .filter((p): p is (typeof carriedRows)[number] => !!p)
        .map((p) => ({ ...scrub(p), carried: true }));
      return {
        // never serialise the workspace id: it is the owner's only credential
        ...scrub(r),
        isViewerRun: r.ownerId === adminOwnerId() && adminOwnerId() !== "",
        // the council's own order (EV-driven), fresh picks before carried ones
        predictions: [...fresh, ...carried].sort((a, b) => (a.carried === b.carried ? a.sortOrder - b.sortOrder : a.carried ? 1 : -1)),
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    date?: string;
    sports?: string[];
    markets?: string[];
    includeEvents?: string[];
    discipline?: string;
  } | null;
  // Only sports we actually have a feed for (a stale client may still send removed ones).
  const sports = (body?.sports ?? []).filter((s) => typeof s === "string" && SPORT_PATHS[s]);
  if (!body?.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) || !sports.length) {
    return Response.json({ error: "date + sports required" }, { status: 400 });
  }
  await ensureSchema();
  const [run] = await db
    .insert(runs)
    .values({
      ownerId: ownerFromRequest(req),
      slateDate: body.date,
      sports: sports.slice(0, 8),
      includeEvents: Array.isArray(body.includeEvents) ? body.includeEvents.slice(0, 400) : [],
      markets: Array.isArray(body.markets) ? body.markets.slice(0, 40) : [],
      discipline: disciplineOf(body.discipline),
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
