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
): Promise<Response> {
  const v = vault ?? loadVault();
  const encoded = encodeVault(v);
  const headers = new Headers(init.headers);
  if (encoded) headers.set("x-neonslip-keys", encoded);
  return fetch(input, { ...init, headers });
}
