p = 'src/lib/agents.ts'
s = open(p).read()
s = s.replace('const byId = new Map(rows.map((r) => [r.agentKey, r]));', 'const byId = new Map(rows.map((r) => [r.agentKey || r.id, r]));')
s = s.replace('const byId = new Map(rows.map((r) => [r.id, r]));', 'const byId = new Map(rows.map((r) => [r.agentKey || r.id, r]));')
open(p, 'w').write(s)
print("agents byId patched.")
