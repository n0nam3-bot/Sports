import { NextRequest } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { listAgents } from "@/lib/agents";
import { keysFromRequest, targetFor } from "@/lib/llm";
import { ownerFromRequest } from "@/lib/owner";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const keys = keysFromRequest(req);
  const list = await listAgents(ownerFromRequest(req));
  // Model assignment is computed live so visitor-supplied keys are reflected
  // immediately, without persisting anyone's credentials.
  const withLive = list.map((a) => ({
    ...a,
    model: targetFor(a.agentKey, keys)?.label ?? "heuristic-core",
  }));
  return Response.json({ agents: withLive });
}

// Operator override: hand-tune an agent's prompt or model label.
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    id?: string;
    prompt?: string;
  } | null;
  if (!body?.id || typeof body.prompt !== "string" || body.prompt.trim().length < 20) {
    return Response.json({ error: "id + prompt (min 20 chars) required" }, { status: 400 });
  }
  // Scoped to the caller's workspace — visitors can never edit each other's
  // prompts, only their own copy of the roster.
  const owner = ownerFromRequest(req);
  await listAgents(owner); // ensure this workspace owns a roster first
  const res = await db
    .update(agents)
    .set({ prompt: body.prompt.trim().slice(0, 6000), updatedAt: new Date() })
    .where(and(eq(agents.ownerId, owner), eq(agents.agentKey, body.id)))
    .returning({ id: agents.id });
  if (!res.length) {
    return Response.json({ error: "agent not found in your workspace" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
