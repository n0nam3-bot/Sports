/**
 * Visitor identity.
 *
 * Each browser mints a random workspace id (stored in its own localStorage)
 * and sends it as `x-neonslip-owner`. Everything the cluster produces — runs,
 * predictions, agent prompts and ratings — is scoped to that id, so:
 *   • your win/loss record reflects only YOUR picks
 *   • nobody else can edit the prompts you have tuned
 * Requests without the header fall back to the shared "house" workspace.
 */
export const HOUSE = "house";

export function ownerFromRequest(req: Request): string {
  const raw = req.headers.get("x-neonslip-owner");
  if (!raw) return HOUSE;
  const clean = raw.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return clean.length >= 8 ? clean : HOUSE;
}
