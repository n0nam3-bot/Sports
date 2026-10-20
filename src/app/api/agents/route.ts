import { NextRequest } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { listAgents, resetAgentPlaybook } from "@/lib/agents";
import { keysFromRequest, llmEnabledFromRequest, targetFor } from "@/lib/llm";
import { HOUSE, isAdminRequest } from "@/lib/owner";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function GET(req: NextRequest) {
  const keys = keysFromRequest(req);
  const llmEnabled = llmEnabledFromRequest(req);
  const list = await listAgents();
  // Model assignment is computed live so visitor-supplied keys are reflected
  // immediately, without persisting anyone's credentials.
  const withLive = list.map((a) => ({
    ...a,
    model: targetFor(a.agentKey, keys, llmEnabled)?.label ?? "heuristic-core",
  }));
  return Response.json({ agents: withLive, isAdmin: isAdminRequest(req) });
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
  // Only the site owner (ADMIN_OWNER_ID in env) may edit agent prompts.
  // This prevents visitors from tampering with the shared agent roster.
  if (!isAdminRequest(req)) {
    return Response.json(
      { error: "prompt editing is restricted to the site owner. set ADMIN_OWNER_ID in your Vercel environment variables to your workspace id to unlock this." },
      { status: 403 },
    );
  }
  await listAgents();
  // The pipeline only ever reads the HOUSE roster, so that is the only copy to
  // edit. (This used to match on agentKey alone and rewrote every workspace's copy.)
  const res = await db
    .update(agents)
    .set({ prompt: body.prompt.trim().slice(0, 6000), updatedAt: new Date() })
    .where(and(eq(agents.ownerId, HOUSE), eq(agents.agentKey, body.id)))
    .returning({ id: agents.id });
  if (!res.length) {
    return Response.json({ error: "agent not found in the house roster" }, { status: 404 });
  }
  return Response.json({ ok: true });
}


// Operator action: restore an agent to its built-in playbook. The prompt being
// replaced is archived in the agent's log, so the action is reversible.
export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  if (!body?.id) return Response.json({ error: "id required" }, { status: 400 });

  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, HOUSE), eq(agents.agentKey, body.id)));
  if (!row) return Response.json({ error: "not found" }, { status: 404 });

  const ok = await resetAgentPlaybook(row);
  if (!ok) return Response.json({ error: "no built-in playbook for this agent" }, { status: 404 });
  return Response.json({ ok: true });
}
