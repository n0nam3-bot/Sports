import { NextRequest } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { listAgents } from "@/lib/agents";

export const dynamic = "force-dynamic";

export async function GET() {
  const list = await listAgents();
  return Response.json({ agents: list });
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
  await db
    .update(agents)
    .set({ prompt: body.prompt.trim().slice(0, 6000), updatedAt: new Date() })
    .where(eq(agents.id, body.id));
  return Response.json({ ok: true });
}
