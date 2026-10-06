import re

p = 'src/lib/fighter-stats.ts'
s = open(p).read()

if 'pace:' not in s:
    s = s.replace('''export interface EnhancedCombatModel {
  pHome: number;''', '''export interface EnhancedCombatModel {
  pace: string;
  cardio: string;
  pHome: number;''')

    s = s.replace('''    summaryLines = [
      `${weightClass}${scheduledRounds === 5 ? " · 5-round" : ""}`,
      stanceNote + (reachNote ? ` · ${reachNote}` : ""),
      strNote,
      tdNote,
      `Finish probability: ${(pFinish * 100).toFixed(0)}%`,
    ];''', '''    // Pace & Cardio evaluation
    const combinedSLpM = awayProfile.strikeLPM + homeProfile.strikeLPM;
    const pace = combinedSLpM > 9 ? "High pace" : combinedSLpM > 6.5 ? "Moderate pace" : "Slow pace";
    const cardioA = awayProfile.decisionPct > 40 ? "proven" : awayProfile.decisionPct < 15 ? "suspect" : "average";
    const cardioH = homeProfile.decisionPct > 40 ? "proven" : homeProfile.decisionPct < 15 ? "suspect" : "average";
    const cardio = `${awayProfile.displayName} cardio is ${cardioA}, ${homeProfile.displayName} is ${cardioH}`;

    summaryLines = [
      `${weightClass}${scheduledRounds === 5 ? " · 5-round" : ""}`,
      stanceNote + (reachNote ? ` · ${reachNote}` : ""),
      strNote,
      tdNote,
      `${pace}. ${cardio}`,
    ];''')

    s = s.replace('''    return {
      pHome,''', '''    return {
      pace: "Unknown pace",
      cardio: "Unknown cardio",
      pHome,''').replace('''  return {
    pHome,''', '''  return {
    pace: statsUsed ? (awayProfile!.strikeLPM + homeProfile!.strikeLPM > 9 ? "High pace" : "Moderate pace") : "Unknown pace",
    cardio: "See summary",
    pHome,''')

open(p, 'w').write(s)
print("Fighter stats patched for pace/cardio.")
