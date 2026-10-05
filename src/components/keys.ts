"use client";

// Visitor-owned credential vault.
// Keys live ONLY in this browser's localStorage. They are attached to outgoing
// API calls as a single base64 header for the lifetime of that request and are
// never written to the server's database or logs.

export interface KeyVault {
  gemini: string;
  xai: string;
  openrouter: string;
  ollamaUrl: string;
  geminiModel: string;
  grokModel: string;
  openrouterModel: string;
  ollamaModel: string;
}

export type LlmMode = "off" | "on";

export const EMPTY_VAULT: KeyVault = {
  gemini: "",
  xai: "",
  openrouter: "",
  ollamaUrl: "",
  geminiModel: "",
  grokModel: "",
  openrouterModel: "",
  ollamaModel: "",
};

const STORAGE_KEY = "neonslip.vault.v1";
const OWNER_KEY = "neonslip.owner.v1";
const LLM_MODE_KEY = "neonslip.llm-mode.v1";

/**
 * Private workspace id for this browser. Everything the cluster produces for
 * you — runs, picks, agent prompts and ratings — is filed under it, so your
 * record is yours alone and nobody can edit your tuned prompts.
 */
export function getOwnerId(): string {
  if (typeof window === "undefined") return "";
  try {
    let id = window.localStorage.getItem(OWNER_KEY);
    if (!id || id.length < 8) {
      const raw =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      id = `w${raw.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
      window.localStorage.setItem(OWNER_KEY, id);
    }
    return id;
  } catch {
    return "";
  }
}

export function loadVault(): KeyVault {
  if (typeof window === "undefined") return { ...EMPTY_VAULT };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_VAULT };
    return { ...EMPTY_VAULT, ...(JSON.parse(raw) as Partial<KeyVault>) };
  } catch {
    return { ...EMPTY_VAULT };
  }
}

export function saveVault(v: KeyVault): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* private mode / quota — keys simply won't persist */
  }
}

export function clearVault(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export function loadLlmMode(): LlmMode {
  if (typeof window === "undefined") return "off";
  try {
    return window.localStorage.getItem(LLM_MODE_KEY) === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

export function saveLlmMode(mode: LlmMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LLM_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function vaultActive(v: KeyVault): boolean {
  return !!(v.gemini || v.xai || v.openrouter || v.ollamaUrl);
}

function encodeVault(v: KeyVault): string | null {
  const payload: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" && val.trim()) payload[k] = val.trim();
  }
  if (!Object.keys(payload).length) return null;
  const json = JSON.stringify(payload);
  // btoa is ASCII-only; encode UTF-8 safely first.
  return typeof window === "undefined"
    ? null
    : window.btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}

/** fetch() wrapper that transparently attaches the visitor's keys. */
export async function vaultFetch(
  input: string,
  init: RequestInit = {},
  vault?: KeyVault,
  opts: { llmMode?: LlmMode } = {},
): Promise<Response> {
  const v = vault ?? loadVault();
  const encoded = encodeVault(v);
  const headers = new Headers(init.headers);
  if (encoded) headers.set("x-neonslip-keys", encoded);
  const owner = getOwnerId();
  if (owner) headers.set("x-neonslip-owner", owner);
  const mode = opts.llmMode ?? loadLlmMode();
  headers.set("x-neonslip-llm", mode);
  return fetch(input, { ...init, headers });
}
