// Multi-provider free-LLM router. Order of preference is read from env:
//   OPENROUTER_API_KEY / OPENROUTER_MODEL
//   GEMINI_API_KEY     / GEMINI_MODEL
//   XAI_API_KEY        / GROK_MODEL
//   OLLAMA_BASE_URL    / OLLAMA_MODEL      (local daemon)
// Agents are spread across every configured provider so the cluster
// truly runs on a mix of models. With zero keys it reports "heuristic".

export interface LLMTarget {
  provider: "gemini" | "grok" | "openrouter" | "ollama";
  model: string;
  label: string;
}

/**
 * Per-request credentials supplied by the visitor's own browser.
 * These are NEVER written to the database or logs — they live in the caller's
 * localStorage, travel on a single request, and are discarded after it ends.
 */
export interface KeyBag {
  gemini?: string;
  xai?: string;
  openrouter?: string;
  ollamaUrl?: string;
  geminiModel?: string;
  grokModel?: string;
  openrouterModel?: string;
  ollamaModel?: string;
}

const DEFAULT_MODELS = {
  openrouter: "nvidia/nemotron-3-super-120b-a12b:free",
  gemini: "gemini-2.5-flash",
  grok: "grok-3-mini",
  ollama: "llama3.1",
};

/** Attaches the resolved secret so calls work without touching process.env. */
export interface ResolvedTarget extends LLMTarget {
  secret: string;
}

export function llmEnabledFromRequest(req: Request): boolean {
  return req.headers.get("x-neonslip-llm") !== "off";
}

export function configuredProviders(keys: KeyBag = {}, enabled = true): ResolvedTarget[] {
  if (!enabled) return [];
  const out: ResolvedTarget[] = [];
  const orKey = keys.openrouter || process.env.OPENROUTER_API_KEY;
  if (orKey) {
    const model =
      keys.openrouterModel || process.env.OPENROUTER_MODEL || DEFAULT_MODELS.openrouter;
    out.push({ provider: "openrouter", model, label: `openrouter/${model}`, secret: orKey });
  }
  const gemKey = keys.gemini || process.env.GEMINI_API_KEY;
  if (gemKey) {
    const model = keys.geminiModel || process.env.GEMINI_MODEL || DEFAULT_MODELS.gemini;
    out.push({ provider: "gemini", model, label: `gemini/${model}`, secret: gemKey });
  }
  const xaiKey = keys.xai || process.env.XAI_API_KEY;
  if (xaiKey) {
    const model = keys.grokModel || process.env.GROK_MODEL || DEFAULT_MODELS.grok;
    out.push({ provider: "grok", model, label: `xai/${model}`, secret: xaiKey });
  }
  const ollama = keys.ollamaUrl || process.env.OLLAMA_BASE_URL;
  if (ollama) {
    const model = keys.ollamaModel || process.env.OLLAMA_MODEL || DEFAULT_MODELS.ollama;
    out.push({ provider: "ollama", model, label: `ollama/${model}`, secret: ollama });
  }
  return out;
}

// Stable hash → spread agents round-robin over every configured provider.
export function targetFor(agentId: string, keys: KeyBag = {}, enabled = true): ResolvedTarget | null {
  const providers = configuredProviders(keys, enabled);
  if (!providers.length) return null;
  let h = 0;
  for (const ch of agentId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return providers[h % providers.length];
}

/** Parses the x-neonslip-keys header (base64 JSON) into a KeyBag. */
export function keysFromRequest(req: Request): KeyBag {
  const raw = req.headers.get("x-neonslip-keys");
  if (!raw) return {};
  try {
    const json = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const pick = (k: string): string | undefined => {
      const v = parsed[k];
      return typeof v === "string" && v.trim() ? v.trim().slice(0, 400) : undefined;
    };
    return {
      gemini: pick("gemini"),
      xai: pick("xai"),
      openrouter: pick("openrouter"),
      ollamaUrl: pick("ollamaUrl"),
      geminiModel: pick("geminiModel"),
      grokModel: pick("grokModel"),
      openrouterModel: pick("openrouterModel"),
      ollamaModel: pick("ollamaModel"),
    };
  } catch {
    return {};
  }
}

async function post(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function llmChat(
  target: ResolvedTarget,
  system: string,
  user: string,
  opts: { timeoutMs?: number; json?: boolean; temperature?: number } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 28000;
  const temperature = opts.temperature ?? 0.4;
  try {
    if (target.provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${target.model}:generateContent?key=${encodeURIComponent(target.secret)}`;
      const data = await post(
        url,
        {
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            temperature,
            ...(opts.json ? { responseMimeType: "application/json" } : {}),
          },
        },
        {},
        timeoutMs,
      );
      const text = (data?.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => p.text ?? "")
        .join("");
      return text || null;
    }
    if (target.provider === "grok") {
      const data = await post(
        "https://api.x.ai/v1/chat/completions",
        {
          model: target.model,
          temperature,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        { authorization: `Bearer ${target.secret}` },
        timeoutMs,
      );
      return data?.choices?.[0]?.message?.content ?? null;
    }
    if (target.provider === "openrouter") {
      const data = await post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: target.model,
          temperature,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        {
          authorization: `Bearer ${target.secret}`,
          "http-referer": "https://neonslip.app",
          "x-title": "NEONSLIP Agent Cluster",
        },
        timeoutMs,
      );
      return data?.choices?.[0]?.message?.content ?? null;
    }
    if (target.provider === "ollama") {
      const base = (target.secret || "http://localhost:11434").replace(/\/$/, "");
      const data = await post(
        `${base}/api/chat`,
        {
          model: target.model,
          stream: false,
          options: { temperature },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        {},
        timeoutMs,
      );
      return data?.message?.content ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

// Extract JSON from a model response, tolerating prose fences.
export function extractJson<T = any>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    /* fall through */
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence?.[1] ?? text;
  const start = raw.search(/[{\[]/);
  const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
  return null;
}

export async function llmJson<T = any>(
  target: ResolvedTarget,
  system: string,
  user: string,
  opts: { timeoutMs?: number; temperature?: number } = {},
): Promise<T | null> {
  const text = await llmChat(target, system, user, { ...opts, json: true });
  if (!text) return null;
  return extractJson<T>(text);
}
