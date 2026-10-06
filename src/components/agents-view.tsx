"use client";

import { useState } from "react";
import {
  Activity, BookOpen, Brain, Crosshair, Gavel, Hourglass, LineChart,
  Scale, Save, ShieldCheck, Stethoscope, Swords, Wrench, GitCommitVertical,
  Sigma, Eye,
} from "lucide-react";
import type { AgentC } from "./types";
import { Chip, LadderBar, Panel, cx } from "./ui";
import { vaultFetch } from "./keys";

const ICONS: Record<string, typeof Brain> = {
  "expert-nfl": Swords,
  "expert-nba": Swords,
  "expert-mlb": Swords,
  "expert-nhl": Swords,
  "expert-mma": Swords,
  "expert-ncaaf": Swords,
  "expert-ncaab": Swords,
  "scout-quant": Sigma,
  "scout-medic": Stethoscope,
  "scout-chrono": Hourglass,
  "scout-matchup": Swords,
  "scout-sharp": LineChart,
  "scout-props": Crosshair,
  "analyst-stratega": Brain,
  "analyst-contrarian": Scale,
  "council-historian": BookOpen,
  "council-commissioner": Gavel,
  "council-risk": ShieldCheck,
};

function tierOf(rating: number): { name: string; tone: string } {
  if (rating >= 1650) return { name: "GRANDMASTER", tone: "magenta" };
  if (rating >= 1580) return { name: "ELITE SHARP", tone: "cyan" };
  if (rating >= 1540) return { name: "PRO", tone: "green" };
  if (rating >= 1490) return { name: "JOURNEYMAN", tone: "slate" };
  if (rating >= 1440) return { name: "ROOKIE", tone: "amber" };
  return { name: "ON TRIAL", tone: "red" };
}

const LAYER_META: Record<string, { title: string; tone: string; blurb: string }> = {
  scout: {
    title: "Layer 01 — Scout Division",
    tone: "cyan",
    blurb: "Field agents. Raw intel only: stats, injuries, rest, matchups, market reads, player spots.",
  },
  analyst: {
    title: "Layer 02 — Analyst Desk",
    tone: "violet",
    blurb: "Synthesis engine. Fuses scout intel into release-grade candidates — and tries to kill them.",
  },
  council: {
    title: "Layer 03 — War Council",
    tone: "magenta",
    blurb: "Final authority. Memory, ranking, bankroll. Only its survivors make your slip.",
  },
};

export default function AgentsView({ agents, reload, isAdmin }: { agents: AgentC[]; reload: () => void; isAdmin?: boolean }) {
  const layers = ["scout", "analyst", "council"] as const;
  const totalW = agents.reduce((s, a) => s + a.wins, 0);
  const totalL = agents.reduce((s, a) => s + a.losses, 0);
  const totalP = agents.reduce((s, a) => s + a.pushes, 0);
  const totalDecisive = totalW + totalL;
  const globalWinrate = totalDecisive > 0 ? (totalW / totalDecisive) * 100 : 0;
  const totalPredictions = totalW + totalL + totalP;
  const avgRating = agents.length ? agents.reduce((s, a) => s + a.rating, 0) / agents.length : 1500;

  return (
    <div className="space-y-8">
      {/* header vitals */}
      <div className="flex flex-wrap items-center gap-3">
        <Activity className="h-6 w-6 text-[#9d7bff]" />
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight title-stroke">The Roster</h2>
        <Chip tone="violet">{agents.length} agents</Chip>
        <Chip tone={avgRating >= 1500 ? "green" : "amber"}>fleet rating {avgRating.toFixed(0)}</Chip>
        <Chip tone="slate">{totalW}W – {totalL}L collective</Chip>
        <Chip tone="cyan">Global: {globalWinrate.toFixed(1)}% WR ({totalPredictions} picks)</Chip>
        <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-[0.18em] text-[#3d4c63] md:block">
          ratings rise &amp; fall on graded slips · losers rewrite their own playbooks
        </span>
      </div>

      {layers.map((layer) => {
        const meta = LAYER_META[layer];
        const list = agents.filter((a) => a.layer === layer);
        if (!list.length) return null;
        return (
          <section key={layer} className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-3 border-b border-white/8 pb-2">
              <h3 className={cx("font-mono text-[12px] font-bold uppercase tracking-[0.3em]",
                layer === "scout" ? "text-[#39d5ff]" : layer === "analyst" ? "text-[#9d7bff]" : "text-[#ff3d81]")}>
                {meta.title}
              </h3>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#5f7089]">{meta.blurb}</span>
            </div>
            <div className={cx("grid gap-4",
              layer === "scout" ? "md:grid-cols-2 xl:grid-cols-3" : layer === "analyst" ? "md:grid-cols-2" : "md:grid-cols-3")}>
              {list.map((a) => (
                <AgentCard key={a.id} agent={a} reload={reload} isAdmin={isAdmin} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function AgentCard({ agent, reload, isAdmin }: { agent: AgentC; reload: () => void; isAdmin?: boolean }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.prompt);
  const [saving, setSaving] = useState(false);
  const tier = tierOf(agent.rating);
  const Icon = ICONS[agent.id] ?? Brain;
  const layerColor = agent.layer === "scout" ? "#39d5ff" : agent.layer === "analyst" ? "#9d7bff" : "#ff3d81";
  const graded = agent.wins + agent.losses;
  const strike = graded > 0 ? (agent.wins / graded) * 100 : null;

  async function save() {
    setSaving(true);
    await vaultFetch("/api/agents", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: agent.agentKey || agent.id, prompt: draft }),
    });
    setSaving(false);
    setEditing(false);
    reload();
  }

  return (
    <Panel className="rise relative overflow-hidden p-4">
      <div className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${layerColor}55, transparent)` }} />

      {/* identity */}
      <div className="flex items-start gap-3">
        <div className="clip-tag flex h-11 w-11 shrink-0 items-center justify-center border" style={{ borderColor: `${layerColor}44`, background: `${layerColor}11` }}>
          <Icon className="h-5 w-5" style={{ color: layerColor }} strokeWidth={1.6} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-display text-[16px] font-bold tracking-wide text-[#e8f1fb]">{agent.codename}</span>
            <Chip tone={tier.tone}>{tier.name}</Chip>
          </div>
          <div className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-[#5f7089]">{agent.title}</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[22px] font-bold leading-none" style={{ color: layerColor }}>
            {agent.rating.toFixed(0)}
          </div>
          <div className="font-mono text-[8.5px] uppercase tracking-[0.2em] text-[#3d4c63]">rating</div>
        </div>
      </div>

      {/* model + record */}
      <div className="mt-3 flex items-center justify-between gap-2 font-mono text-[9.5px] uppercase tracking-[0.12em]">
        <span className="clip-tag flex items-center gap-1 border border-white/10 bg-white/[0.04] px-2 py-1 text-[#8fa3bd]">
          <Sigma className="h-3 w-3" /> {agent.model}
        </span>
        <span className="text-[#5f7089]">
          <span className="font-bold text-[#37ff8b]">{agent.wins}W</span>
          {" – "}
          <span className="font-bold text-[#ff4757]">{agent.losses}L</span>
          {agent.pushes > 0 && <span className="text-[#8fa3bd]"> – {agent.pushes}P</span>}
          {strike != null && <span className="ml-2 text-[#39d5ff]">{strike.toFixed(0)}%</span>}
        </span>
      </div>
      <div className="mt-1.5"><LadderBar wins={agent.wins} losses={agent.losses} pushes={agent.pushes} /></div>

      {/* job */}
      <p className="mt-3 border-l-2 pl-3 text-[12px] leading-relaxed text-[#8fa3bd]" style={{ borderColor: `${layerColor}55` }}>
        {agent.job}
      </p>

      {/* prompt */}
      <div className="mt-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[#5f7089] transition hover:text-[#d7e3f0]"
        >
          <Eye className="h-3.5 w-3.5" /> {open ? "hide" : "inspect"} playbook prompt
        </button>
        {open && (
          <div className="mt-2 space-y-2">
            {editing ? (
              <>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={10}
                  className="w-full resize-y border border-[#39d5ff]/25 bg-[#05080f] p-3 font-mono text-[11px] leading-relaxed text-[#b8c6da] outline-none focus:border-[#39d5ff]/60"
                />
                <div className="flex gap-2">
                  <button onClick={save} disabled={saving} className="clip-tag flex items-center gap-1.5 border border-[#37ff8b]/40 bg-[#37ff8b]/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#37ff8b] hover:brightness-125">
                    <Save className="h-3 w-3" /> {saving ? "saving…" : "deploy prompt"}
                  </button>
                  <button onClick={() => { setEditing(false); setDraft(agent.prompt); }} className="clip-tag border border-white/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[#8fa3bd]">
                    abort
                  </button>
                </div>
              </>
            ) : (
              <>
                <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap border border-white/8 bg-[#05080f] p-3 font-mono text-[10.5px] leading-relaxed text-[#8fa3bd]">
                  {agent.prompt}
                </pre>
                {isAdmin && <button onClick={() => setEditing(true)} className="clip-tag flex items-center gap-1.5 border border-[#9d7bff]/35 bg-[#9d7bff]/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#9d7bff] hover:brightness-125">
                  <Wrench className="h-3 w-3" /> hand-tune prompt
                </button>}
                {isAdmin && <button onClick={async () => {
                  await vaultFetch("/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: agent.agentKey || agent.id }) });
                  reload();
                }} className="clip-tag flex items-center gap-1.5 border border-[#ff3d81]/35 bg-[#ff3d81]/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#ff3d81] hover:brightness-125 ml-2">
                  <Wrench className="h-3 w-3" /> force improve
                </button>}
              </>
            )}
          </div>
        )}
      </div>

      {/* self improvement log */}
      {agent.improvements.length > 0 && (
        <div className="mt-3 border-t border-white/6 pt-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-[#ffb020]">
            <GitCommitVertical className="h-3.5 w-3.5" /> self-corrections
          </div>
          <div className="space-y-1.5">
            {agent.improvements.slice(-3).reverse().map((imp, i) => (
              <div key={i} className="border-l border-[#ffb020]/30 pl-2.5">
                <div className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-[#ffb020]">
                  {imp.at.slice(0, 10)} · {imp.reason}
                </div>
                <div className="text-[10.5px] leading-snug text-[#8fa3bd]">{imp.detail}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
