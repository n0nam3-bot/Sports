export const RELEASE = {
  version: "4.0.0",
  name: "Global Fleet & Tactical Experts",
  built: "2026-09-29",
  sports: ["NBA", "NFL", "NCAAF", "NCAAB", "MLB", "NHL", "UFC", "DWCS", "PFL"],
  features: {
    combatCards: true,
    fightWinner: true,
    fightMethod: true,
    fightRounds: true,
    marketFocus: true,
    touchdowns: true,
    rushingYards: true,
    receivingYards: true,
    privateWorkspaces: true,
    duplicateProtection: true,
    byoAiKeys: true,
    modelDropdowns: true,
    combatModelOdds: true,
    rerunShowsFullCard: true,
    globalAgents: true,
    sportTacticians: true,
    adminForceImprove: true,
  },
  boxing: {
    enabled: false,
    reason:
      "ESPN returns 'Invalid sport (boxing)' and no free feed publishes bout-level schedules, records or results to grade. Shown as unavailable rather than faked.",
  },
  mmaOdds: {
    source: "model",
    reason:
      "ESPN's MMA odds endpoint returns zero items for every bout, so UFC/DWCS/PFL prices are the model's own fair numbers and are labelled as such.",
  },
} as const;

export const RELEASE_LABEL = `v${RELEASE.version} · ${RELEASE.name}`;
