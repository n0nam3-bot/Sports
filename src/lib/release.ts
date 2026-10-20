export const RELEASE = {
  version: "5.0.0",
  name: "Market-Anchored Engine",
  built: "2026-10-14",
  sports: ["NBA", "NFL", "NCAAF", "NCAAB", "MLB", "NHL", "UFC", "DWCS", "PFL"],
  features: {
    // engine
    marketAnchoredModel: true,
    vigFreeBaseline: true,
    noForcedCard: true,
    fractionalKellyStaking: true,
    convergenceRequired: true,
    trackRecordGating: true,
    boundedLlmReview: true,
    // MMA
    mmaJointModel: true,
    mmaMoneyline: true,
    mmaTotalRounds: true,
    mmaGoesDistance: true,
    mmaStartRound: true,
    mmaFinishSpread: true,
    mmaMethodOfVictory: true,
    mmaSigStrikes: true,
    mmaTakedowns: true,
    // product
    personalBetTracker: true,
    pricePageProvenance: true,
    disciplineDial: true,
    marketFocus: true,
    privateWorkspaces: true,
    duplicateProtection: true,
    byoAiKeys: true,
  },
  mmaOdds: {
    source: "model (ESPN moneyline used when published)",
    reason:
      "ESPN publishes no sportsbook price for most MMA markets, so UFC/DWCS/PFL picks are model-priced: each states our probability, our fair price and the worst price at which it is still a play. If ESPN does publish a bout moneyline, it is matched to fighters by athlete id and used as a real price.",
  },
} as const;

export const RELEASE_LABEL = `v${RELEASE.version} · ${RELEASE.name}`;
