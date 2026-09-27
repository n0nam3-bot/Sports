import { NextRequest } from "next/server";
import { configuredProviders, keysFromRequest, llmChat } from "@/lib/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

// Live-fires a one-token prompt at each configured provider so the visitor
// knows instantly whether their own key works. Keys are never persisted.
export async function POST(req: NextRequest) {
  const keys = keysFromRequest(req);
  const providers = configuredProviders(keys);
  if (!providers.length) {
    return Response.json({
      ok: false,
      providers: [],
      message: "No keys detected — the cluster will run on the built-in quant core.",
    });
  }
  const results = await Promise.all(
    providers.map(async (t) => {
      const started = Date.now();
      const reply = await llmChat(
        t,
        "You are a connectivity probe. Reply with exactly: OK",
        "Reply with exactly: OK",
        { timeoutMs: 15000, temperature: 0 },
      );
      return {
        label: t.label,
        provider: t.provider,
        ok: !!reply,
        ms: Date.now() - started,
        sample: reply ? reply.trim().slice(0, 40) : null,
        error: reply ? null : "no response — check the key, model name, or free-tier quota",
      };
    }),
  );
  return Response.json({
    ok: results.some((r) => r.ok),
    providers: results,
    message: `${results.filter((r) => r.ok).length}/${results.length} provider(s) responding.`,
  });
}
