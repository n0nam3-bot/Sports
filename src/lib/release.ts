export const RELEASE = {
  version: "3.1.0",
  name: "Combat + Market Focus",
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
  },
  boxing: {
    enabled: false,
    reason: "No reliable free bout-level schedule, records, results, and grading feed is available.",
  },
} as const;

export const RELEASE_LABEL = `v${RELEASE.version} · ${RELEASE.name}`;
