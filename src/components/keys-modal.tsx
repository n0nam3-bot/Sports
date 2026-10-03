"use client";

import { useState } from "react";
import {
  CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, Trash2, X, XCircle,
} from "lucide-react";
import { clearVault, saveVault, vaultFetch, type KeyVault } from "./keys";
import { Chip, NeonButton, Panel, cx } from "./ui";

interface ProviderTest {
  label: string;
  provider: string;
  ok: boolean;
  ms: number;
  error: string | null;
}

/** Curated free / free-tier-friendly models per provider. */
const MODEL_CHOICES: Record<string, { value: string; note: string }[]> = {
  gemini: [
    { value: "gemini-2.5-flash", note: "strong · may require prior usage" },
    { value: "gemini-2.5-flash-lite", note: "lighter · may require prior usage" },
    { value: "gemini-3.5-flash-lite", note: "newest lite · recommended" },
    { value: "gemini-3.8-flash", note: "newest flagship · recommended" },
  ],
  openrouter: [
    { value: "nvidia/nemotron-3-super-120b-a12b:free", note: "free · reliable" },
    { value: "nvidia/nemotron-3.5-lightning:free", note: "free · 1M context" },
    { value: "cohere/north-mini-code:free", note: "free · fast · reliable" },
    { value: "meta-llama/llama-3.3-70b-instruct:free", note: "free · if available" },
    { value: "nvidia/nemotron-3-ultra-550b-a55b:free", note: "free · largest" },
    { value: "inclusionai/ling-3.0-flash-sante:free", note: "free · reliable" },
  ],
  xai: [
    { value: "grok-3-mini", note: "cheapest · may need credits" },
    { value: "grok-3", note: "flagship · needs credits" },
  ],
  ollamaUrl: [
    { value: "llama3.1", note: "8B · solid default" },
    { value: "llama3.2", note: "3B · very fast" },
    { value: "qwen2.5", note: "strong at JSON" },
    { value: "mistral", note: "7B · lightweight" },
    { value: "phi3", note: "tiny · low RAM" },
    { value: "gemma2", note: "9B · Google quality" },
  ],
};

const OTHER = "__other__";

function ModelPicker({
  provider,
  value,
  placeholder,
  onChange,
}: {
  provider: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  const choices = MODEL_CHOICES[provider] ?? [];
  const known = choices.some((c) => c.value === value);
  const [custom, setCustom] = useState(!known && value !== "");

  return (
    <div className="flex flex-1 flex-col gap-2">
      <select
        value={custom ? OTHER : value || ""}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setCustom(true);
            onChange("");
          } else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
        className="w-full border border-white/12 bg-[#05080f] px-3 py-2.5 font-mono text-[11px] text-[#8fa3bd] outline-none transition focus:border-[#39d5ff]/50"
      >
        <option value="">default ({placeholder})</option>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.value} — {c.note}
          </option>
        ))}
        <option value={OTHER}>Other — type a model id…</option>
      </select>
      {custom && (
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="exact model id, e.g. mistralai/mistral-7b-instruct:free"
          className="w-full border border-[#39d5ff]/30 bg-[#05080f] px-3 py-2.5 font-mono text-[11px] text-[#d7e3f0] outline-none focus:border-[#39d5ff]/60"
        />
      )}
    </div>
  );
}

const FIELDS: {
  key: keyof KeyVault;
  modelKey?: keyof KeyVault;
  label: string;
  tone: string;
  placeholder: string;
  modelPlaceholder?: string;
  signup: string;
  blurb: string;
}[] = [
  {
    key: "gemini",
    modelKey: "geminiModel",
    label: "Google Gemini",
    tone: "cyan",
    placeholder: "AIza…",
    modelPlaceholder: "gemini-2.0-flash",
    signup: "https://aistudio.google.com/app/apikey",
    blurb: "Best free tier — generous daily limits, no card required.",
  },
  {
    key: "openrouter",
    modelKey: "openrouterModel",
    label: "OpenRouter",
    tone: "violet",
    placeholder: "sk-or-v1-…",
    modelPlaceholder: "google/gemini-2.0-flash-001",
    signup: "https://openrouter.ai/keys",
    blurb: "Gateway to many models. Append :free to a model id for free routes.",
  },
  {
    key: "xai",
    modelKey: "grokModel",
    label: "xAI Grok",
    tone: "magenta",
    placeholder: "xai-…",
    modelPlaceholder: "grok-3-mini",
    signup: "https://console.x.ai",
    blurb: "Often ships promotional free credits for new consoles.",
  },
  {
    key: "ollamaUrl",
    modelKey: "ollamaModel",
    label: "Ollama (local)",
    tone: "green",
    placeholder: "http://localhost:11434",
    modelPlaceholder: "llama3.1",
    signup: "https://ollama.com",
    blurb: "Runs on your own machine — unlimited and totally free. Install Ollama, run \"ollama serve\" and \"ollama pull llama3.1\", then paste http://localhost:11434 here. Only works when your PC and this site are on the same network (not possible on Vercel → use ngrok or a VPN tunnel to expose it).",
  },
];

export default function KeysModal({
  vault,
  setVault,
  onClose,
  onSaved,
}: {
  vault: KeyVault;
  setVault: (v: KeyVault) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<KeyVault>(vault);
  const [reveal, setReveal] = useState(false);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<ProviderTest[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const set = (k: keyof KeyVault, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  async function test() {
    setTesting(true);
    setResults(null);
    try {
      const res = await vaultFetch("/api/keys/test", { method: "POST" }, draft);
      const data = await res.json();
      setResults(data.providers ?? []);
      setMessage(data.message ?? null);
    } catch {
      setMessage("probe failed — check your connection");
    } finally {
      setTesting(false);
    }
  }

  function save() {
    saveVault(draft);
    setVault(draft);
    onSaved();
    onClose();
  }

  function wipe() {
    clearVault();
    setDraft({ ...vault, gemini: "", xai: "", openrouter: "", ollamaUrl: "" });
    setVault({
      gemini: "", xai: "", openrouter: "", ollamaUrl: "",
      geminiModel: "", grokModel: "", openrouterModel: "", ollamaModel: "",
    });
    setResults(null);
    setMessage("vault wiped from this device");
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/80 p-3 backdrop-blur-sm sm:p-6">
      <Panel className="panel-glow rise my-auto w-full max-w-3xl">
        {/* header */}
        <div className="flex items-center gap-3 border-b border-white/8 px-5 py-4">
          <KeyRound className="h-5 w-5 text-[#37ff8b]" />
          <div className="flex-1">
            <h2 className="font-display text-lg font-bold tracking-tight text-[#e8f1fb]">
              Bring Your Own AI
            </h2>
            <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-[#5f7089]">
              optional — the cluster already runs free without any keys
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-[#5f7089] transition hover:bg-white/8 hover:text-[#d7e3f0]">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* privacy notice */}
        <div className="mx-5 mt-4 flex items-start gap-2.5 border border-[#37ff8b]/25 bg-[#37ff8b]/6 px-3.5 py-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#37ff8b]" />
          <p className="text-[12px] leading-relaxed text-[#9fb4cc]">
            <span className="font-semibold text-[#37ff8b]">Your keys stay on your device.</span> They are
            saved in this browser&apos;s local storage and attached only to your own requests — never
            written to the server database, never logged, never shared with other visitors. Each person
            who opens this site uses their own keys (or none at all).
          </p>
        </div>

        {/* fields */}
        <div className="space-y-4 px-5 py-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[#5f7089]">
              provider credentials
            </span>
            <button
              onClick={() => setReveal((r) => !r)}
              className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[#5f7089] transition hover:text-[#d7e3f0]"
            >
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {reveal ? "hide" : "reveal"}
            </button>
          </div>

          {FIELDS.map((f) => {
            const result = results?.find((r) => r.provider === (f.key === "ollamaUrl" ? "ollama" : f.key === "xai" ? "grok" : f.key));
            return (
              <div key={f.key} className="border-l-2 border-white/10 pl-3">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="font-display text-[13.5px] font-bold text-[#e8f1fb]">{f.label}</span>
                  <a
                    href={f.signup}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#39d5ff] hover:underline"
                  >
                    get key <ExternalLink className="h-3 w-3" />
                  </a>
                  {result && (
                    <Chip tone={result.ok ? "green" : "red"}>
                      {result.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                      {result.ok ? `live ${result.ms}ms` : "failed"}
                    </Chip>
                  )}
                </div>
                <p className="mb-2 text-[11px] leading-snug text-[#5f7089]">{f.blurb}</p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                  <input
                    type={reveal ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    value={draft[f.key]}
                    onChange={(e) => set(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    className="flex-[2] border border-white/12 bg-[#05080f] px-3 py-2.5 font-mono text-[12px] text-[#d7e3f0] outline-none transition focus:border-[#37ff8b]/50"
                  />
                  {f.modelKey && (
                    <ModelPicker
                      provider={f.key}
                      value={draft[f.modelKey]}
                      placeholder={f.modelPlaceholder ?? ""}
                      onChange={(v) => set(f.modelKey!, v)}
                    />
                  )}
                </div>
                {result?.error && (
                  <p className="mt-1 font-mono text-[10px] text-[#ff8296]">{result.error}</p>
                )}
              </div>
            );
          })}

          {message && (
            <div className="border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#8fa3bd]">
              {message}
            </div>
          )}
        </div>

        {/* actions */}
        <div className="flex flex-wrap items-center gap-2.5 border-t border-white/8 px-5 py-4">
          <NeonButton tone="cyan" onClick={test} disabled={testing}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            {testing ? "probing…" : "test keys"}
          </NeonButton>
          <NeonButton onClick={save}>
            <CheckCircle2 className="h-3.5 w-3.5" /> save to this device
          </NeonButton>
          <button
            onClick={wipe}
            className={cx(
              "clip-tag ml-auto flex items-center gap-1.5 border border-[#ff4757]/30 bg-[#ff4757]/8 px-3 py-2",
              "font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#ff4757] transition hover:brightness-125",
            )}
          >
            <Trash2 className="h-3.5 w-3.5" /> wipe vault
          </button>
        </div>
      </Panel>
    </div>
  );
}
