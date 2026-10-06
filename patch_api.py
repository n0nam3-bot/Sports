import re

p = 'src/app/api/agents/route.ts'
s = open(p).read()
s = s.replace('await listAgents(owner); // ensure this workspace owns a roster first', 'await listAgents();')
s = s.replace('await listAgents(ownerFromRequest(req));', 'await listAgents();')
s = s.replace('await listAgents(owner);', 'await listAgents();')
s = s.replace('.where(and(eq(agents.ownerId, owner), eq(agents.agentKey, body.id)))', '.where(eq(agents.agentKey, body.id))')
s = s.replace('.where(eq(agents.agentKey, body.id))', '.where(eq(agents.agentKey, body.id))')
open(p, 'w').write(s)

p = 'src/app/api/runs/route.ts'
s = open(p).read()
s = s.replace('import { and, desc, eq, inArray } from "drizzle-orm";', 'import { desc, inArray } from "drizzle-orm";')
s = s.replace('const owner = ownerFromRequest(req);\n  const list = await db\n    .select()\n    .from(runs)\n    .where(eq(runs.ownerId, owner))\n    .orderBy(desc(runs.id))\n    .limit(40);',
'''  const list = await db
    .select()
    .from(runs)
    .orderBy(desc(runs.id))
    .limit(50);''')
s = s.replace('const carriedRows = carriedIds.length\n    ? await db\n        .select()\n        .from(predictions)\n        .where(and(eq(predictions.ownerId, owner), inArray(predictions.id, carriedIds)))\n    : [];',
'''const carriedRows = carriedIds.length
    ? await db
        .select()
        .from(predictions)
        .where(inArray(predictions.id, carriedIds))
    : [];''')
open(p, 'w').write(s)

p = 'src/app/api/runs/[id]/route.ts'
s = open(p).read()
s = s.replace('.where(and(eq(runs.id, runId), eq(runs.ownerId, owner)));', '.where(eq(runs.id, runId));')
s = s.replace('.where(and(eq(predictions.ownerId, owner), inArray(predictions.id, carriedIds)))', '.where(inArray(predictions.id, carriedIds))')
open(p, 'w').write(s)

p = 'src/app/api/grade/route.ts'
s = open(p).read()
s = s.replace('const summary = await gradePending(ownerFromRequest(req));', 'const summary = await gradePending();')
open(p, 'w').write(s)

print("APIs patched.")
