import re

p = 'src/lib/engine.ts'
s = open(p).read()

old_loop = '''    for (const code of ["QUANT", "MEDIC", "CHRONO", "MATCHUP", "SHARP"] as const) {
      const a = agent(code);
      const target = a ? targetFor(a.id, keys) : null;
      const injGames = pre.filter((g) => g.injuries.length > 0);
      const fatigueGames = pre.filter((g) => g.rest && (g.rest.homeB2B || g.rest.awayB2B || g.rest.home3in4 || g.rest.away3in4));
      const scope: Record<string, string> = {
        QUANT: `power lines built for ${pre.length} games — ${allCandidates.filter((c) => c.category === "spread" || c.category === "moneyline").length} model-vs-market edges flagged.${allCandidates.length > 0 ? ` strongest edge: ${allCandidates[0].pick} (${allCandidates[0].edge.toFixed(1)} pts).` : ""}`,
        MEDIC: injGames.length
          ? `injury impact priced into ${injGames.length} games: ${injGames.slice(0, 3).map((g) => `${g.matchup} (${g.injuries.length} reported)`).join(", ")}${injGames.length > 3 ? ` +${injGames.length - 3} more` : ""}.`
          : `no reportable injuries on this slate — all rosters appear intact.`,
        CHRONO: fatigueGames.length
          ? `fatigue spots identified: ${fatigueGames.slice(0, 3).map((g) => { const r = g.rest!; return `${g.matchup} (${r.homeB2B ? g.home.abbr + " B2B" : r.awayB2B ? g.away.abbr + " B2B" : r.home3in4 ? g.home.abbr + " 3-in-4" : g.away.abbr + " 3-in-4"})`; }).join(", ")}${fatigueGames.length > 3 ? ` +${fatigueGames.length - 3} more` : ""}.`
          : `no significant rest or travel edges on this slate.`,
        MATCHUP: `style analysis complete for ${pre.length} matchups — pace, scoring environment, and scheme collision factors priced.`,
        SHARP: `${pre.filter((g) => g.odds).length}/${pre.length} games carry posted lines. Key number positions and juice asymmetries noted.`,
      };'''

new_loop = '''    const sportsInSlate = [...new Set(pre.map((g) => g.sport))];
    const sportExperts = sportsInSlate.map((s) => `EXPERT_${s.toUpperCase()}`);
    const scoutCodes = ["QUANT", "MEDIC", "CHRONO", ...sportExperts, "SHARP"];

    for (const code of scoutCodes) {
      let a = agent(code);
      if (!a && code.startsWith("EXPERT_")) {
         const sportCode = code.split("_")[1].toLowerCase();
         // map dwcs/pfl to mma expert
         const eCode = ["dwcs", "pfl", "ufc"].includes(sportCode) ? "mma" : sportCode;
         a = agent(`expert-${eCode}`) ?? agent(`expert-nfl`); // fallback just in case
      }
      const target = a ? targetFor(a.id, keys) : null;
      const injGames = pre.filter((g) => g.injuries.length > 0);
      const fatigueGames = pre.filter((g) => g.rest && (g.rest.homeB2B || g.rest.awayB2B || g.rest.home3in4 || g.rest.away3in4));
      
      const scope: Record<string, string> = {
        QUANT: `power lines built for ${pre.length} games — ${allCandidates.filter((c) => c.category === "spread" || c.category === "moneyline").length} model-vs-market edges flagged.${allCandidates.length > 0 ? ` strongest edge: ${allCandidates[0].pick} (${allCandidates[0].edge.toFixed(1)} pts).` : ""}`,
        MEDIC: injGames.length
          ? `injury impact priced into ${injGames.length} games: ${injGames.slice(0, 3).map((g) => `${g.matchup} (${g.injuries.length} reported)`).join(", ")}${injGames.length > 3 ? ` +${injGames.length - 3} more` : ""}.`
          : `no reportable injuries on this slate — all rosters appear intact.`,
        CHRONO: fatigueGames.length
          ? `fatigue spots identified: ${fatigueGames.slice(0, 3).map((g) => { const r = g.rest!; return `${g.matchup} (${r.homeB2B ? g.home.abbr + " B2B" : r.awayB2B ? g.away.abbr + " B2B" : r.home3in4 ? g.home.abbr + " 3-in-4" : g.away.abbr + " 3-in-4"})`; }).join(", ")}${fatigueGames.length > 3 ? ` +${fatigueGames.length - 3} more` : ""}.`
          : `no significant rest or travel edges on this slate.`,
        EXPERT: `tactical analysis complete — sport-specific factors (schemes, weather, matchups) priced.`,
        SHARP: `${pre.filter((g) => g.odds).length}/${pre.length} games carry posted lines. Key number positions and juice asymmetries noted.`,
      };
      
      const scopeKey = code.startsWith("EXPERT_") ? "EXPERT" : code;'''

s = s.replace(old_loop, new_loop)
s = s.replace('message: `${scope[code]}${extra}`,', 'message: `${scope[scopeKey]}${extra}`,')

# Fix signals setting
s = s.replace('c.signals = [...new Set([...c.signals, "STRATEGA", "CONTRARIAN", "COMMISSIONER", "RISK", "HISTORIAN"])];',
              'c.signals = [...new Set([...c.signals.map(s => s === "MATCHUP" ? "EXPERT" : s), "STRATEGA", "CONTRARIAN", "COMMISSIONER", "RISK", "HISTORIAN"])];')

open(p, 'w').write(s)
print("Scouts patched.")
