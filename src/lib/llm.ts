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

export function configuredProviders(): LLMTarget[] {
  const out: LLMTarget[] = [];
  if (process.env.OPENROUTER_API_KEY)
    out.push({
      provider: "openrouter",
      model: process.env.OPENROUTER_MODEL ?? "google/gemini-2.0-flash-001",
      label: `openrouter/${process.env.OPENROUTER_MODEL ?? "google/gemini-2.0-flash-001"}`,
    });
  if (process.env.GEMINI_API_KEY)
    out.push({
      provider: "gemini",
      model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
      label: `gemini/${process.env.GEMINI_MODEL ?? "gemini-2.0-flash"}`,
    });
  if (process.env.XAI_API_KEY)
    out.push({
      provider: "grok",
      model: process.env.GROK_MODEL ?? "grok-3-mini",
      label: `xai/${process.env.GROK_MODEL ?? "grok-3-mini"}`,
    });
  if (process.env.OLLAMA_BASE_URL)
    out.push({
      provider: "ollama",
      model: process.env.OLLAMA_MODEL ?? "llama3.1",
      label: `ollama/${process.env.OLLAMA_MODEL ?? "llama3.1"}`,
    });
  return out;
}

// Stable hash → spread agents round-robin over providers.
export function targetFor(agentId: string): LLMTarget | null {
  const providers = configuredProviders();
  if (!providers.length) return null;
  let h = 0;
  for (const ch of agentId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return providers[h % providers.length];
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
  target: LLMTarget,
  system: string,
  user: string,
  opts: { timeoutMs?: number; json?: boolean; temperature?: number } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 28000;
  const temperature = opts.temperature ?? 0.4;
  try {
    if (target.provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${target.model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
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
        { authorization: `Bearer ${process.env.XAI_API_KEY}` },
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
          authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "http-referer": "https://neonslip.app",
          "x-title": "NEONSLIP Agent Cluster",
        },
        timeoutMs,
      );
      return data?.choices?.[0]?.message?.content ?? null;
    }
    if (target.provider === "ollama") {
      const base = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
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
  target: LLMTarget,
  system: string,
  user: string,
  opts: { timeoutMs?: number; temperature?: number } = {},
): Promise<T | null> {
  const text = await llmChat(target, system, user, { ...opts, json: true });
  if (!text) return null;
  return extractJson<T>(text);
}
