p = 'src/lib/engine.ts'
s = open(p).read()

# Add STRATEGA details to trace
if 'forged ${allCandidates.length} raw signals' in s:
    s = s.replace('''    await trace(runId, {
      layer: "analyst",
      agent: "STRATEGA",
      message: `forged ${allCandidates.length} raw signals — top ${top.length} theses graded for release, convergence-weighted (multi-scout agreement counts heaviest).`,
      mood: "info",
    });''', '''    const strategaDetails = out?.verdicts?.map(v => `#${v.id} (conf ${v.confidence}): ${v.thesis}`).join(' | ') || 'no detailed theses returned';
    await trace(runId, {
      layer: "analyst",
      agent: "STRATEGA",
      message: `forged ${allCandidates.length} raw signals — top ${top.length} theses graded for release. Details: ${strategaDetails}`,
      mood: "info",
    });''')

# Add CONTRARIAN details to trace
if 'audit complete —' in s:
    s = s.replace('''    await trace(runId, {
      layer: "analyst",
      agent: "CONTRARIAN",
      message: `audit complete — ${vetoCount} candidate${vetoCount === 1 ? "" : "s"} vetoed (juice/trap/sub-threshold), ${allCandidates.filter((c) => c.discount && !c.vetoed).length} discounted, ${allCandidates.filter((c) => !c.vetoed).length} cleared for the council floor.`,
      mood: vetoCount ? "warn" : "info",
    });''', '''    const contraDetails = out?.audits?.filter(a => a.verdict !== "CONFIRM").map(a => `#${a.id} ${a.verdict}: ${a.why}`).join(' | ') || 'all confirmed';
    await trace(runId, {
      layer: "analyst",
      agent: "CONTRARIAN",
      message: `audit complete — ${vetoCount} vetoed, ${allCandidates.filter((c) => c.discount && !c.vetoed).length} discounted, ${allCandidates.filter((c) => !c.vetoed).length} cleared. Notes: ${contraDetails}`,
      mood: vetoCount ? "warn" : "info",
    });''')

open(p, 'w').write(s)
print("Traces patched.")
