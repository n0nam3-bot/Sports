/**
 * Visitor identity.
 *
 * Each browser mints a random workspace id (stored in its own localStorage)
 * and sends it as `x-neonslip-owner`. Everything the cluster produces — runs,
 * predictions, agent prompts and ratings — is scoped to that id.
 *
 * ADMIN_OWNER_ID env var: the site owner can set this to their own workspace
 * id. That unlocks:
 *   1. Prompt editing on the house agents (the shared roster everyone sees).
 *   2. The "owner" badge on runs and predictions in the shared feed.
 * Without this env var, all users share the same read-only house roster.
 */
export const HOUSE = "house";

export function ownerFromRequest(req: Request): string {
  const raw = req.headers.get("x-neonslip-owner");
  if (!raw) return HOUSE;
  const clean = raw.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return clean.length >= 8 ? clean : HOUSE;
}

/** The designated site-owner workspace id, if configured. */
export function adminOwnerId(): string {
  return (process.env.ADMIN_OWNER_ID ?? "").trim() || "";
}

/** Returns true when this request comes from the configured site owner. */
export function isAdminRequest(req: Request): boolean {
  const aid = adminOwnerId();
  if (!aid) return false;
  return ownerFromRequest(req) === aid;
}
