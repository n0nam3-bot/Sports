"use client";

import { useState } from "react";
import {
  ChevronDown, CircleCheck, Globe, Lock, RefreshCw, ScrollText, Star, Target, TrendingUp, Vault,
} from "lucide-react";
import type { PredC, RunC } from "./types";
import { CategoryChip, Chip, OutcomeChip, Panel, cx } from "./ui";
import { vaultFetch, loadLlmMode } from "./keys";

function profit(p: PredC): number {
  if (p.outcome === "win") return p.units * (p.odds > 0 ? p.odds / 100 : 100 / -p.odds);
  if (p.outcome === "loss") return -p.units;
  return 0;
}

function StatBlock({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <Panel className="min-w-[130px] flex-1 px-4 py-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-[#5f7089]">{label}</div>
      <div className={cx("mt-0.5 font-mono text-[24px] font-bold", tone)}>{value}</div>
    </Panel>
  );
}

export default function RunsView({ runs, grade }: { runs: RunC[]; grade: () => Promise<void> | void }) {
  const [openId, setOpenId] = useState<number | null>(runs[0]?.id ?? null);
  const [syncing, setSyncing] = useState(false);
  const [publishing, setPublishing] = useState<number | null>(null);

  async function togglePublic(runId: number, currentlyPublic: boolean) {
    setPublishing(runId);
    try {
      await vaultFetch("/api/runs/public", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, public: !currentlyPublic }),
      }, undefined, { llmMode: loadLlmMode() });
    } finally {
      setPublishing(null);
    }
  }

  const allPreds = runs.flatMap((r) => r.predictions);
  const graded = allPreds.filter((p) => p.outcome !== "pending");
  const wins = graded.filter((p) => p.outcome === "win").length;
  const losses = graded.filter((p) => p.outcome === "loss").length;
  const decisive = wins + losses;
  const strike = decisive ? (wins / decisive) * 100 : null;
  const pnl = allPreds.reduce((s, p) => s + profit(p), 0);
  const pending = allPreds.length - graded.length;

  async function sync() {
    setSyncing(true);
    await grade();
    setSyncing(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <ScrollText className="h-6 w-6 text-[#ffb020]" />
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight title-stroke">Prediction Ledger</h2>
        <Chip tone="amber">{runs.length} runs archived</Chip>
        <button
          onClick={sync}
          disabled={syncing}
          className="clip-tag ml-auto flex items-center gap-2 border border-[#37ff8b]/40 bg-[#37ff8b]/10 px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[#37ff8b] transition hover:brightness-125 disabled:opacity-40"
        >
          <RefreshCw className={cx("h-3.5 w-3.5", syncing && "animate-spin")} />
          {syncing ? "settling…" : "sync final scores & grade"}
        </button>
      </div>

      {/* scoreboard strip */}
      <div className="flex flex-wrap gap-3">
        <StatBlock label="graded record" value={`${wins}–${losses}`} tone="text-[#e8f1fb]" />
        <StatBlock label="strike rate" value={strike != null ? `${strike.toFixed(1)}%` : "—"} tone={strike != null && strike >= 52.4 ? "text-[#37ff8b]" : "text-[#ffb020]"} />
        <StatBlock label="units p/l" value={`${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}u`} tone={pnl >= 0 ? "text-[#37ff8b]" : "text-[#ff4757]"} />
        <StatBlock label="pending" value={String(pending)} tone="text-[#ffb020]" />
        <div className="hidden min-w-[220px] flex-1 items-center gap-3 md:flex">
          <Panel className="flex w-full items-center gap-3 px-4 py-3">
            <Vault className="h-5 w-5 text-[#9d7bff]" />
            <p className="font-mono text-[9.5px] uppercase leading-relaxed tracking-[0.14em] text-[#5f7089]">
              this is the global prediction ledger. all runs from all users are shown here. duplicates are automatically detected and graded once. official runs are highlighted.
            </p>
          </Panel>
        </div>
      </div>

      {runs.length === 0 && (
        <Panel className="p-10 text-center font-mono text-[12px] uppercase tracking-[0.2em] text-[#5f7089]">
          no runs yet — hit <span className="text-[#37ff8b]">run the cluster</span> in the war room
        </Panel>
      )}

      {/* run list */}
      <div className="space-y-3">
        {runs.map((r) => {
          const open = openId === r.id;
          const rp = r.predictions;
          const rg = rp.filter((p) => p.outcome !== "pending");
          const rw = rp.filter((p) => p.outcome === "win").length;
          const rl = rp.filter((p) => p.outcome === "loss").length;
          const rpnl = rp.reduce((s, p) => s + profit(p), 0);
          return (
            <Panel key={r.id} className="overflow-hidden">
              <button
                onClick={() => setOpenId(open ? null : r.id)}
                className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 text-left transition hover:bg-white/[0.025]"
              >
                <span className="font-mono text-[11px] font-bold text-[#3d4c63]">#{r.id}</span>
                {r.isViewerRun && <Chip tone="magenta" className="ml-2">Official</Chip>}
                {!r.isViewerRun && <Chip tone="slate" className="ml-2">Community</Chip>}
                <span className="font-display text-[15px] font-bold text-[#e8f1fb]">{r.slateDate}</span>
                <span className="flex gap-1">
                  {r.sports.map((s) => (
                    <span key={s} className="clip-tag border border-[#39d5ff]/25 bg-[#39d5ff]/8 px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-[0.12em] text-[#39d5ff]">{s}</span>
                  ))}
                </span>
                <Chip tone={r.mode === "llm" ? "green" : "cyan"}>{r.mode === "llm" ? "llm swarm" : "quant core"}</Chip>
                <Chip tone={r.status === "completed" ? "green" : r.status === "running" ? "amber" : "red"}>{r.status}</Chip>
                {r.status === "completed" && (
                  <button
                    onClick={(e) => { e.stopPropagation(); void togglePublic(r.id, !!r.isPublic); }}
                    disabled={publishing === r.id}
                    className={cx(
                      "clip-tag flex items-center gap-1 border px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-[0.12em] transition-all",
                      r.isPublic
                        ? "border-[#37ff8b]/40 bg-[#37ff8b]/10 text-[#37ff8b]"
                        : "border-white/15 bg-white/[0.04] text-[#5f7089] hover:border-[#37ff8b]/30 hover:text-[#37ff8b]",
                    )}
                    title={r.isPublic ? "public — click to make private" : "private — click to share publicly"}
                  >
                    {r.isPublic ? <Globe className="h-2.5 w-2.5" /> : <Lock className="h-2.5 w-2.5" />}
                    {r.isPublic ? "public" : "private"}
                  </button>
                )}
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#5f7089]">
                  {r.gamesAnalyzed} analyzed · {r.gamesSkipped} skipped
                </span>
                {rp.length > 0 && (
                  <span className="font-mono text-[11px] font-bold">
                    <span className="text-[#37ff8b]">{rw}W</span>
                    <span className="text-[#3d4c63]"> – </span>
                    <span className="text-[#ff4757]">{rl}L</span>
                    {rg.length > 0 && (
                      <span className={cx("ml-2", rpnl >= 0 ? "text-[#37ff8b]" : "text-[#ff4757]")}>
                        {rpnl >= 0 ? "+" : ""}{rpnl.toFixed(1)}u
                      </span>
                    )}
                    {rp.length - rg.length > 0 && <span className="ml-2 text-[#ffb020]">{rp.length - rg.length} open</span>}
                  </span>
                )}
                <ChevronDown className={cx("ml-auto h-4 w-4 text-[#5f7089] transition-transform", open && "rotate-180")} />
              </button>

              {open && (
                <div className="border-t border-white/6 px-4 py-4">
                  {r.council?.headline && (
                    <div className="mb-4 flex items-start gap-3 border-l-2 border-[#ff3d81]/50 pl-3">
                      <Target className="mt-0.5 h-4 w-4 shrink-0 text-[#ff3d81]" />
                      <div>
                        <div className="font-display text-[14px] font-bold text-[#e8f1fb]">{r.council.headline}</div>
                        <div className="text-[12px] leading-relaxed text-[#8fa3bd]">{r.council.memo}</div>
                      </div>
                    </div>
                  )}

                  {rp.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[720px] border-collapse font-mono text-[11px]">
                        <thead>
                          <tr className="text-left text-[9px] uppercase tracking-[0.2em] text-[#3d4c63]">
                            <th className="pb-2 pr-3">#</th>
                            <th className="pb-2 pr-3">market</th>
                            <th className="pb-2 pr-3">pick</th>
                            <th className="pb-2 pr-3">matchup</th>
                            <th className="pb-2 pr-3 text-right">odds</th>
                            <th className="pb-2 pr-3 text-right">conf</th>
                            <th className="pb-2 pr-3 text-right">stake</th>
                            <th className="pb-2 pr-3 text-right">result</th>
                            <th className="pb-2 text-right">final</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rp.map((p) => (
                             <tr
                               key={p.id}
                               className={cx(
                                 "border-t border-white/5",
                                 p.isDuplicate ? "text-[#5f7089] opacity-65" : "text-[#b8c6da]",
                               )}
                             >
                               <td className="py-2 pr-3 text-[#3d4c63]">
                                 {p.isDuplicate && p.canonRunId
                                   ? <span title={`same bet as run #${p.canonRunId} — not counted again`}><Star className="inline h-3 w-3 text-[#ffb020]" /></span>
                                   : p.sortOrder + 1}
                               </td>
                               <td className="py-2 pr-3"><CategoryChip category={p.category} /></td>
                               <td className="max-w-[260px] py-2 pr-3">
                                 <span className={cx("font-sans text-[12px] font-semibold", p.isDuplicate ? "text-[#5f7089] line-through" : "text-[#e8f1fb]")}>{p.pick}</span>
                                 {p.isDuplicate && p.canonRunId && (
                                   <span className="ml-2 font-mono text-[8.5px] uppercase tracking-wider text-[#8fa3bd]">graded on #{p.canonRunId}</span>
                                 )}
                               </td>
                               <td className="py-2 pr-3 text-[#8fa3bd]">{p.matchup}</td>
                               <td className="py-2 pr-3 text-right text-[#ffb020]">{p.odds > 0 ? `+${p.odds}` : p.odds}</td>
                               <td className="py-2 pr-3 text-right text-[#39d5ff]">{p.confidence.toFixed(0)}</td>
                               <td className="py-2 pr-3 text-right">{p.units.toFixed(1)}u</td>
                               <td className="py-2 pr-3 text-right"><OutcomeChip outcome={p.outcome} /></td>
                               <td className="py-2 text-right text-[#5f7089]">{p.finalScore ?? "—"}</td>
                             </tr>
                           ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#5f7089]">
                      {r.status === "running" ? "cluster still thinking — trace streaming in the war room" : "no bets released on this card"}
                    </div>
                  )}

                  {r.trace.length > 0 && (
                    <details className="mt-4">
                      <summary className="cursor-pointer font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[#5f7089] hover:text-[#d7e3f0]">
                        agent transcript ({r.trace.length} entries)
                      </summary>
                      <div className="mt-2 max-h-64 space-y-1 overflow-y-auto border border-white/8 bg-[#05080f] p-3 font-mono text-[10.5px] leading-relaxed text-[#8fa3bd]">
                        {r.trace.map((t, i) => (
                          <div key={i}>
                            <span className="font-bold text-[#39d5ff]">[{t.agent}]</span> {t.message}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </Panel>
          );
        })}
      </div>

      <Panel className="flex items-center gap-3 p-4">
        <TrendingUp className="h-4 w-4 shrink-0 text-[#37ff8b]" />
        <p className="font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-[#5f7089]">
          grading triggers when games go final — hit sync after the last whistle. every settled slip updates
          agent ratings in real time; check the roster to watch reputations burn or rise.
        </p>
        <CircleCheck className="ml-auto h-4 w-4 shrink-0 text-[#3d4c63]" />
      </Panel>
    </div>
  );
}
