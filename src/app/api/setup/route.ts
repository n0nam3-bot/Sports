import { ensureSchema } from "@/lib/schema";
import { ensureAgentsSeeded, listAgents } from "@/lib/agents";
import { db } from "@/db";
import { ownerFromRequest } from "@/lib/owner";
import { runs } from "@/db/schema";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

// One-tap installer: open /api/setup in any browser after pointing the app at
// a fresh Postgres. Creates tables (idempotent) and seeds the agent roster.
export async function GET(req: Request) {
  try {
    await ensureSchema();
    await ensureAgentsSeeded(ownerFromRequest(req));
    const roster = await listAgents(ownerFromRequest(req));
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs);
    return Response.json({
      ok: true,
      message: "NEONSLIP database installed. Close this tab and open the War Room.",
      agents: roster.length,
      runs: count,
      sparkline: roster.map((a) => `${a.codename}:${a.rating.toFixed(0)}`),
    });
  } catch (e) {
    return Response.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "setup failed",
        hint: "Check the DATABASE_URL environment variable on your host.",
      },
      { status: 500 },
    );
  }
}

export const POST = GET;
