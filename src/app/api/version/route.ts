import { RELEASE } from "@/lib/release";

export const dynamic = "force-dynamic";

/** Open this URL after deployment to verify the complete release is live. */
export function GET() {
  return Response.json({ ok: true, ...RELEASE });
}
