import re

p = 'src/components/runs-view.tsx'
s = open(p).read()
if '{r.isViewerRun' not in s:
    s = s.replace('''<span className="font-mono text-[11px] font-bold text-[#3d4c63]">#{r.id}</span>''',
'''<span className="font-mono text-[11px] font-bold text-[#3d4c63]">#{r.id}</span>
                {r.isViewerRun ? (
                  <Chip tone="magenta" className="ml-2">Official</Chip>
                ) : (
                  <Chip tone="slate" className="ml-2">Community</Chip>
                )}''')
open(p, 'w').write(s)

p = 'src/components/agents-view.tsx'
s = open(p).read()
s = s.replace('const ICONS: Record<string, typeof Brain> = {',
'''const ICONS: Record<string, typeof Brain> = {
  "expert-nfl": Swords,
  "expert-nba": Swords,
  "expert-mlb": Swords,
  "expert-nhl": Swords,
  "expert-mma": Swords,
  "expert-ncaaf": Swords,
  "expert-ncaab": Swords,''')
s = s.replace('const totalW = agents.reduce((s, a) => s + a.wins, 0);',
'''const totalW = agents.reduce((s, a) => s + a.wins, 0);
  const totalL = agents.reduce((s, a) => s + a.losses, 0);
  const totalP = agents.reduce((s, a) => s + a.pushes, 0);
  const totalDecisive = totalW + totalL;
  const globalWinrate = totalDecisive > 0 ? (totalW / totalDecisive) * 100 : 0;
  const totalPredictions = totalW + totalL + totalP;''')
s = s.replace('<Chip tone="slate">{totalW}W – {totalL}L collective</Chip>',
'''<Chip tone="slate">{totalW}W – {totalL}L collective</Chip>
        <Chip tone="cyan">Global: {globalWinrate.toFixed(1)}% WR ({totalPredictions} picks)</Chip>''')

# Fix the patch endpoint in agents-view.tsx
s = s.replace('''await fetch("/api/agents", {''',
'''await vaultFetch("/api/agents", {''')
s = s.replace('''body: JSON.stringify({ id: agent.id, prompt: draft }),''',
'''body: JSON.stringify({ id: agent.agentKey || agent.id, prompt: draft }),''')
s = s.replace('''import { Chip, LadderBar, Panel, cx } from "./ui";''', '''import { Chip, LadderBar, Panel, cx } from "./ui";
import { vaultFetch } from "./keys";''')
open(p, 'w').write(s)

p = 'src/app/api/runs/route.ts'
s = open(p).read()
s = s.replace('import { ownerFromRequest } from "@/lib/owner";', 'import { ownerFromRequest, adminOwnerId } from "@/lib/owner";')
s = s.replace('isViewerRun: r.ownerId === viewer,', 'isViewerRun: r.ownerId === adminOwnerId() && adminOwnerId() !== "",')
open(p, 'w').write(s)
print("UI patched.")
