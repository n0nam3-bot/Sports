import re

p = 'src/app/api/agents/route.ts'
s = open(p).read()
if 'export async function POST' not in s:
    s += '''

// Admin override: Force an agent to self-improve immediately
export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  if (!body?.id) return Response.json({ error: "id required" }, { status: 400 });
  
  const owner = ownerFromRequest(req);
  const [row] = await db.select().from(agents).where(and(eq(agents.ownerId, "house"), eq(agents.agentKey, body.id)));
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  
  const imps = row.improvements ?? [];
  const entry = {
    at: new Date().toISOString(),
    reason: "Operator Forced Rewrite",
    detail: "Admin triggered a manual playbook rebuild.",
    ratingBefore: row.rating,
    ratingAfter: row.rating,
  };
  const newPrompt = `${row.prompt}\\n\\nSELF-CORRECTION LOG (${entry.at.slice(0, 10)}):\\nAdmin triggered a manual playbook rebuild. Discard stale approaches.`;
  
  await db.update(agents)
    .set({
      prompt: newPrompt.slice(0, 6000),
      improvements: [...imps, entry].slice(-12),
      updatedAt: new Date(),
    })
    .where(and(eq(agents.ownerId, "house"), eq(agents.agentKey, body.id)));
    
  return Response.json({ ok: true });
}
'''

s = s.replace('eq(agents.ownerId, owner)', 'eq(agents.ownerId, "house")')
open(p, 'w').write(s)

p = 'src/components/agents-view.tsx'
s = open(p).read()
if 'force improve' not in s:
    s = s.replace('''hand-tune prompt
                </button>}''', '''hand-tune prompt
                </button>}
                {isAdmin && <button onClick={async () => {
                  await vaultFetch("/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: agent.agentKey || agent.id }) });
                  reload();
                }} className="clip-tag flex items-center gap-1.5 border border-[#ff3d81]/35 bg-[#ff3d81]/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#ff3d81] hover:brightness-125 ml-2">
                  <Wrench className="h-3 w-3" /> force improve
                </button>}''')

open(p, 'w').write(s)
print("Force improvement patched.")
