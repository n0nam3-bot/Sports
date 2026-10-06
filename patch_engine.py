import re

p = 'src/lib/engine.ts'
s = open(p).read()

# 1. Global deduplication in finishRun
if 'where(and(eq(predictions.ownerId, ownerId), eq(predictions.dedupeKey, key)))' in s:
    s = s.replace('.where(and(eq(predictions.ownerId, ownerId), eq(predictions.dedupeKey, key)))', '.where(eq(predictions.dedupeKey, key))')

# 2. Global grading
if 'eq(predictions.ownerId, ownerId)' in s:
    s = s.replace('eq(predictions.ownerId, ownerId),', '')

s = s.replace('export async function gradePending(ownerId: string = HOUSE):', 'export async function gradePending():')
s = s.replace('async function buildLessons(ownerId: string = HOUSE):', 'async function buildLessons():')
s = s.replace('const lessons = await buildLessons(ownerId);', 'const lessons = await buildLessons();')
s = s.replace('await settleAgentRatings(creditList, ownerId);', 'await settleAgentRatings(creditList);')
s = s.replace('await ensureAgentsSeeded(ownerId);', 'await ensureAgentsSeeded();')
s = s.replace('const roster = await db.select().from(agents).where(eq(agents.ownerId, ownerId));', 'const roster = await db.select().from(agents);')

# 3. Combat Candidates "Shop your book" and cardio
s = s.replace('Shop your book: this is only valuable if they post better than ${priceTag}.', '')
s = s.replace('Shop your book: this is only valuable if they post better than ${price > 0 ? "+" : ""}${price}.', '')
s = s.replace('Shop your book: this is only valuable if they post better than ${price > 0 ? "+" : ""}${price}.', '')

s = s.replace('const matchupSummary = (m as any).summary || `${c.weightClass} ${c.scheduledRounds}rd bout`;',
'''const matchupSummary = (m as any).summary || `${c.weightClass} ${c.scheduledRounds}rd bout`;
  const cardioText = m.expRounds > 2.5 ? "Cardio is tested." : "Pace favors early exchanges.";
  const under15 = (m.pFinish * (c.scheduledRounds === 5 ? 0.4 : 0.6) * 100).toFixed(0);
  const mmaExtra = `u1.5 rds prob: ${under15}%. ${cardioText}`;''')

s = s.replace('${matchupSummary}. ${statsLabel}', '${matchupSummary}. ${mmaExtra} ${statsLabel}')
s = s.replace('${matchupSummary}. ${statsLabel}', '${matchupSummary}. ${mmaExtra} ${statsLabel}')

# 4. Scout calling logic: replace MATCHUP with specific sport experts
if 'const a = agent(code);' in s:
    s = s.replace('''    for (const code of ["QUANT", "MEDIC", "CHRONO", "MATCHUP", "SHARP"] as const) {
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
      };
      const a = agent(code);''',
'''    const sportsInSlate = [...new Set(pre.map((g) => g.sport))];
    const sportExperts = sportsInSlate.map((s) => `EXPERT-${s.toUpperCase()}`);
    
    for (const code of ["QUANT", "MEDIC", "CHRONO", ...sportExperts, "SHARP"] as const) {
      const injGames = pre.filter((g) => g.injuries.length > 0);
      const fatigueGames = pre.filter((g) => g.rest && (g.rest.homeB2B || g.rest.awayB2B || g.rest.home3in4 || g.rest.away3in4));
      
      let baseCode = code.split("-")[0];
      if (baseCode === "EXPERT") baseCode = "EXPERT";
      
      const scope: Record<string, string> = {
        QUANT: `power lines built for ${pre.length} games — ${allCandidates.filter((c) => c.category === "spread" || c.category === "moneyline").length} model-vs-market edges flagged.${allCandidates.length > 0 ? ` strongest edge: ${allCandidates[0].pick} (${allCandidates[0].edge.toFixed(1)} pts).` : ""}`,
        MEDIC: injGames.length
          ? `injury impact priced into ${injGames.length} games: ${injGames.slice(0, 3).map((g) => `${g.matchup} (${g.injuries.length} reported)`).join(", ")}${injGames.length > 3 ? ` +${injGames.length - 3} more` : ""}.`
          : `no reportable injuries on this slate — all rosters appear intact.`,
        CHRONO: fatigueGames.length
          ? `fatigue spots identified: ${fatigueGames.slice(0, 3).map((g) => { const r = g.rest!; return `${g.matchup} (${r.homeB2B ? g.home.abbr + " B2B" : r.awayB2B ? g.away.abbr + " B2B" : r.home3in4 ? g.home.abbr + " 3-in-4" : g.away.abbr + " 3-in-4"})`; }).join(", ")}${fatigueGames.length > 3 ? ` +${fatigueGames.length - 3} more` : ""}.`
          : `no significant rest or travel edges on this slate.`,
        EXPERT: `style analysis complete for ${code.split("-")[1] || "SPORT"} matchups — tactical factors priced.`,
        SHARP: `${pre.filter((g) => g.odds).length}/${pre.length} games carry posted lines. Key number positions and juice asymmetries noted.`,
      };
      
      const agentIdLookup = code.startsWith("EXPERT") ? `expert-${code.split("-")[1].toLowerCase()}` : code;
      const a = agent(agentIdLookup);''')

s = s.replace('const SCOUT_CODES = new Set(["QUANT", "MEDIC", "CHRONO", "MATCHUP", "SHARP", "PROPS"]);',
              'const SCOUT_CODES = new Set(["QUANT", "MEDIC", "CHRONO", "EXPERT", "SHARP", "PROPS"]);')

s = s.replace('c.signals = [...new Set([...c.signals, "STRATEGA", "CONTRARIAN", "COMMISSIONER", "RISK", "HISTORIAN"])];',
              'c.signals = [...new Set([...c.signals.map(s => s === "MATCHUP" ? "EXPERT" : s), "STRATEGA", "CONTRARIAN", "COMMISSIONER", "RISK", "HISTORIAN"])];')

open(p, 'w').write(s)
print("Engine patched.")
