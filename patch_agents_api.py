import re

p = 'src/app/api/agents/route.ts'
s = open(p).read()

s = s.replace('''  return Response.json({ agents: withLive });''', '''  return Response.json({ agents: withLive, isAdmin: isAdminRequest(req) });''')
open(p, 'w').write(s)

p = 'src/components/agents-view.tsx'
s = open(p).read()
if 'isAdmin' not in s:
    s = s.replace('export default function AgentsView({ agents, reload }: { agents: AgentC[]; reload: () => void }) {', 'export default function AgentsView({ agents, reload, isAdmin }: { agents: AgentC[]; reload: () => void; isAdmin?: boolean }) {')
    s = s.replace('<AgentCard key={a.id} agent={a} reload={reload} />', '<AgentCard key={a.id} agent={a} reload={reload} isAdmin={isAdmin} />')
    s = s.replace('function AgentCard({ agent, reload }: { agent: AgentC; reload: () => void }) {', 'function AgentCard({ agent, reload, isAdmin }: { agent: AgentC; reload: () => void; isAdmin?: boolean }) {')
    s = s.replace('<button onClick={() => setEditing(true)}', '{isAdmin && <button onClick={() => setEditing(true)}')
    s = s.replace('hand-tune prompt\n                </button>', 'hand-tune prompt\n                </button>}')

open(p, 'w').write(s)

p = 'src/components/app-shell.tsx'
s = open(p).read()
s = s.replace('const [agentsData, setAgentsData] = useState<AgentC[]>([]);', 'const [agentsData, setAgentsData] = useState<AgentC[]>([]);\n  const [isAdmin, setIsAdmin] = useState(false);')
s = s.replace('setAgentsData(data.agents ?? []);', 'setAgentsData(data.agents ?? []);\n    setIsAdmin(!!data.isAdmin);')
s = s.replace('<AgentsView agents={agentsData} reload={loadAgents} />', '<AgentsView agents={agentsData} reload={loadAgents} isAdmin={isAdmin} />')
open(p, 'w').write(s)
print("Admin UI patched.")
