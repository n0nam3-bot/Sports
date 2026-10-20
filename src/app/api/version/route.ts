import { RELEASE } from "@/lib/release";
import { COMBAT_SPORTS } from "@/lib/espn";
import { buildMmaModel, legacyFromModel } from "@/lib/mma-model";

export const dynamic = "force-dynamic";

/** Open this URL after deployment to verify the complete release is live. */
export function GET() {
  // Live-fire the combat model to prove the code path exists on this deployment.
  // If any of these imports are missing (stale upload), the endpoint errors
  // instead of silently claiming everything is fine.
  const probe = buildMmaModel({
    weightClass: "Welterweight",
    scheduledRounds: 3,
    promotion: "ufc",
    away: { record: "12-0-0", profile: null },
    home: { record: "8-2-0", profile: null },
  });
  const fair = legacyFromModel(probe);
  const combatWorking =
    typeof fair.fairHomeML === "number" &&
    typeof probe.pFinish === "number" &&
    COMBAT_SPORTS.size >= 2;

  return Response.json({
    ok: true,
    ...RELEASE,
    deployment: {
      combatModelLoaded: combatWorking,
      combatSports: [...COMBAT_SPORTS],
      probeResult: {
        fairHomeML: fair.fairHomeML,
        fairAwayML: fair.fairAwayML,
        pFinish: probe.pFinish,
      },
    },
  });
}
