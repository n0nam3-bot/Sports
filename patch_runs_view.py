p = 'src/components/runs-view.tsx'
s = open(p).read()
s = s.replace('this ledger is private to your device — your record, your agents, your prompts. duplicate picks are\\n              detected and graded once, so re-running a slate never inflates your win rate.', 'this is the global prediction ledger. all runs from all users are shown here. duplicates are automatically detected and graded once. official runs are highlighted.')
s = s.replace('this ledger is private to your device — your record, your agents, your prompts. duplicate picks are\n              detected and graded once, so re-running a slate never inflates your win rate.', 'this is the global prediction ledger. all runs from all users are shown here. duplicates are automatically detected and graded once. official runs are highlighted.')

s = s.replace('''<span className="font-mono text-[11px] font-bold text-[#3d4c63]">#{r.id}</span>
                {r.isViewerRun ? (
                  <Chip tone="magenta" className="ml-2">Official</Chip>
                ) : (
                  <Chip tone="slate" className="ml-2">Community</Chip>
                )}''', '''<span className="font-mono text-[11px] font-bold text-[#3d4c63]">#{r.id}</span>
                {r.isViewerRun && <Chip tone="magenta" className="ml-2">Official</Chip>}
                {!r.isViewerRun && <Chip tone="slate" className="ml-2">Community</Chip>}''')

open(p, 'w').write(s)
print("Runs view patched.")
