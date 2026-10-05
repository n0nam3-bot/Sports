import { RELEASE } from "@/lib/release";
import { COMBAT_SPORTS } from "@/lib/espn";
import { combatModel } from "@/lib/combat";

export const dynamic = "force-dynamic";

/** Open this URL after deployment to verify the complete release is live. */
export function GET() {
  // Live-fire the combat model to prove the code path exists on this deployment.
  // If any of these imports are missing (stale upload), the endpoint errors
  // instead of silently claiming everything is fine.
  const probe = combatModel("12-0-0", "8-2-0", "Welterweight", 3);
  const combatWorking =
    typeof probe.fairHomeML === "number" &&
    typeof probe.pFinish === "number" &&
    COMBAT_SPORTS.size >= 2;

  return Response.json({
    ok: true,
    ...RELEASE,
    deployment: {
      combatModelLoaded: combatWorking,
      combatSports: [...COMBAT_SPORTS],
      probeResult: {
        fairHomeML: probe.fairHomeML,
        fairAwayML: probe.fairAwayML,
        pFinish: probe.pFinish,
      },
    },
  });
}
