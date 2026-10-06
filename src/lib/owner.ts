export const HOUSE = "house";

export function ownerFromRequest(req: Request): string {
  const raw = req.headers.get("x-neonslip-owner");
  if (!raw) return HOUSE;
  const clean = raw.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return clean.length >= 8 ? clean : HOUSE;
}

export function adminOwnerId(): string {
  return (process.env.ADMIN_OWNER_ID ?? "").trim() || "";
}

export function isAdminRequest(req: Request): boolean {
  const aid = adminOwnerId();
  if (!aid) return false;
  return ownerFromRequest(req) === aid;
}
