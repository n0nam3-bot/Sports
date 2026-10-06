import re

p = 'src/components/agents-view.tsx'
s = open(p).read()
s = re.sub(r'const totalL = agents\.reduce\(\(s, a\) => s \+ a\.losses, 0\);\s*const totalL = agents\.reduce\(\(s, a\) => s \+ a\.losses, 0\);', 'const totalL = agents.reduce((s, a) => s + a.losses, 0);', s)
open(p, 'w').write(s)

p = 'src/components/types.ts'
s = open(p).read()
if 'agentKey?: string;' not in s:
    s = s.replace('id: string; codename: string;', 'id: string; agentKey?: string; codename: string;')
open(p, 'w').write(s)

p = 'src/lib/engine.ts'
s = open(p).read()
s = s.replace('''    const strategaDetails = out?.verdicts?.map(v => `#${v.id} (conf ${v.confidence}): ${v.thesis}`).join(' | ') || 'no detailed theses returned';''',
              '''    const strategaDetails = typeof out !== "undefined" ? out?.verdicts?.map((v: any) => `#${v.id} (conf ${v.confidence}): ${v.thesis}`).join(' | ') || 'no detailed theses returned' : 'no LLM verdicts';''')
s = s.replace('''    const contraDetails = out?.audits?.filter(a => a.verdict !== "CONFIRM").map(a => `#${a.id} ${a.verdict}: ${a.why}`).join(' | ') || 'all confirmed';''',
              '''    const contraDetails = typeof out !== "undefined" ? out?.audits?.filter((a: any) => a.verdict !== "CONFIRM").map((a: any) => `#${a.id} ${a.verdict}: ${a.why}`).join(' | ') || 'all confirmed' : 'no LLM audits';''')
open(p, 'w').write(s)
print("Errors fixed.")
