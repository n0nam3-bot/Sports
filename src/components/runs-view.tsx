"use client";

import { useMemo, useState } from "react";
import {
  ChevronDown, CircleCheck, Filter, Globe, Lock, RefreshCw, ScrollText,
  Star, Target, TrendingUp, Vault,
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
    <Panel className="min-w-[100px] flex-1 px-3 py-2.5">
      <div className="font-mono text-[8px] uppercase tracking-[0.22em] text-[#5f7089]">{label}</div>
      <div className={cx("mt-0.5 font-mono text-[20px] font-bold", tone)}>{value}</div>
    </Panel>
  );
}

type ViewMode = "all" | "official" | "community";

const ALL_SPORT_FILTERS = ["nfl", "nba", "mlb", "nhl", "ncaaf", "ncaab", "ufc", "dwcs", "pfl"] as const;

export default function RunsView({ runs, grade }: { runs: RunC[]; grade: () => Promise<void> | void }) {
  const [openId, setOpenId] = useState<number | null>(runs[0]?.id ?? null);
  const [syncing, setSyncing] = useState(false);
  const [publishing, setPublishing] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("all");
  const [sportFilter, setSportFilter] = useState<string | null>(null);

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

  // ---- filtering ----
  const filtered = useMemo(() => {
    let list = runs;
    if (viewMode === "official") list = list.filter((r) => r.isViewerRun);
    if (viewMode === "community") list = list.filter((r) => !r.isViewerRun);
    if (sportFilter) list = list.filter((r) => r.sports.includes(sportFilter));
    return list;
  }, [runs, viewMode, sportFilter]);

  // ---- stats computation ----
  function computeStats(runList: RunC[]) {
    const seen = new Set<string>();
    const preds = runList.flatMap((r) => r.predictions);
    let w = 0, l = 0, push = 0, pnlSum = 0, pendingCount = 0;
    for (const p of preds) {
      // Only count each unique wager once across all runs
      const key = p.dedupeKey || `${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (p.outcome === "pending") { pendingCount++; continue; }
      if (p.outcome === "win") { w++; pnlSum += p.units * (p.odds > 0 ? p.odds / 100 : 100 / -p.odds); }
      else if (p.outcome === "loss") { l++; pnlSum -= p.units; }
      else if (p.outcome === "push") { push++; }
    }
    const d = w + l;
    return { wins: w, losses: l, strike: d ? (w / d) * 100 : null, pnl: pnlSum, pending: pendingCount, total: seen.size };
  }

  const officialStats = useMemo(() => computeStats(runs.filter((r) => r.isViewerRun)), [runs]);
  const communityStats = useMemo(() => computeStats(runs.filter((r) => !r.isViewerRun)), [runs]);
  const filteredStats = useMemo(() => computeStats(filtered), [filtered]);

  // Map of dedupeKey -> first run that staked it
  const firstStakes = useMemo(() => {
    const map = new Map<string, RunC>();
    [...runs].sort((a, b) => a.id - b.id).forEach(r => {
      r.predictions.forEach(p => {
        if (p.dedupeKey && !map.has(p.dedupeKey)) {
          map.set(p.dedupeKey, r);
        }
      });
    });
    return map;
  }, [runs]);

  // sort: Date first, then official on top
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (a.slateDate !== b.slateDate) {
        return b.slateDate.localeCompare(a.slateDate);
      }
      if (a.isViewerRun && !b.isViewerRun) return -1;
      if (!a.isViewerRun && b.isViewerRun) return 1;
      return b.id - a.id;
    });
  }, [filtered]);

  // ---- sports that appear in runs ----
  const activeSports = useMemo(() => {
    const set = new Set<string>();
    runs.forEach((r) => r.sports.forEach((s) => set.add(s)));
    return ALL_SPORT_FILTERS.filter((s) => set.has(s));
  }, [runs]);

  async function sync() { setSyncing(true); await grade(); setSyncing(false); }

  const st = filteredStats;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <ScrollText className="h-6 w-6 text-[#ffb020]" />
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight title-stroke">
          Prediction Ledger
        </h2>
        <Chip tone="amber">{filtered.length} runs</Chip>
        <button
          onClick={sync}
          disabled={syncing}
          className="clip-tag ml-auto flex items-center gap-2 border border-[#37ff8b]/40 bg-[#37ff8b]/10 px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[#37ff8b] transition hover:brightness-125 disabled:opacity-40"
        >
          <RefreshCw className={cx("h-3.5 w-3.5", syncing && "animate-spin")} />
          {syncing ? "settling…" : "sync & grade"}
        </button>
      </div>

      {/* ============ View Mode Toggle ============ */}
      <div className="flex flex-wrap items-center gap-2">
        {(["all", "official", "community"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={cx(
              "clip-tag border px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] transition-all",
              viewMode === mode
                ? mode === "official"
                  ? "border-[#ff3d81]/45 bg-[#ff3d81]/14 text-[#ff3d81]"
                  : mode === "community"
                    ? "border-[#5f7089]/45 bg-[#5f7089]/14 text-[#8fa3bd]"
                    : "border-[#37ff8b]/45 bg-[#37ff8b]/14 text-[#37ff8b]"
                : "border-white/10 bg-white/[0.03] text-[#5f7089] hover:border-white/25",
            )}
          >
            {mode === "all" ? "All Runs" : mode === "official" ? "Official Only" : "Community Only"}
          </button>
        ))}

        <span className="mx-1 text-[#3d4c63]">|</span>

        <Filter className="h-3.5 w-3.5 text-[#5f7089]" />
        <button
          onClick={() => setSportFilter(null)}
          className={cx(
            "clip-tag border px-2 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em] transition-all",
            !sportFilter
              ? "border-[#39d5ff]/45 bg-[#39d5ff]/14 text-[#39d5ff]"
              : "border-white/10 bg-white/[0.03] text-[#5f7089] hover:border-white/25",
          )}
        >
          all sports
        </button>
        {activeSports.map((sp) => (
          <button
            key={sp}
            onClick={() => setSportFilter(sportFilter === sp ? null : sp)}
            className={cx(
              "clip-tag border px-2 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em] transition-all",
              sportFilter === sp
                ? "border-[#39d5ff]/45 bg-[#39d5ff]/14 text-[#39d5ff]"
                : "border-white/10 bg-white/[0.03] text-[#5f7089] hover:border-white/25",
            )}
          >
            {sp}
          </button>
        ))}
      </div>

      {/* ============ Stats Strip ============ */}
      <div className="flex flex-wrap gap-2">
        <StatBlock
          label={sportFilter ? `${sportFilter.toUpperCase()} record` : viewMode === "official" ? "official record" : viewMode === "community" ? "community record" : "overall record"}
          value={`${st.wins}–${st.losses}`}
          tone="text-[#e8f1fb]"
        />
        <StatBlock
          label="win rate"
          value={st.strike != null ? `${st.strike.toFixed(1)}%` : "—"}
          tone={st.strike != null && st.strike >= 52.4 ? "text-[#37ff8b]" : "text-[#ffb020]"}
        />
        <StatBlock label="units p/l" value={`${st.pnl >= 0 ? "+" : ""}${st.pnl.toFixed(1)}u`} tone={st.pnl >= 0 ? "text-[#37ff8b]" : "text-[#ff4757]"} />
        <StatBlock label="pending" value={String(st.pending)} tone="text-[#ffb020]" />
        
        {/* Dynamic breakdown blocks */}
        {viewMode === "all" && !sportFilter && officialStats.total > 0 && communityStats.total > 0 && (
          <>
            <StatBlock label="official WR" value={officialStats.strike != null ? `${officialStats.strike.toFixed(1)}%` : "—"} tone={officialStats.strike != null && officialStats.strike >= 52.4 ? "text-[#ff3d81]" : "text-[#ffb020]"} />
            <StatBlock label="community WR" value={communityStats.strike != null ? `${communityStats.strike.toFixed(1)}%` : "—"} tone="text-[#8fa3bd]" />
          </>
        )}
        
        {sportFilter && viewMode === "all" && (
           <div className="hidden min-w-[200px] flex-1 items-center gap-3 md:flex">
             <Panel className="flex w-full items-center gap-3 px-4 py-2 border-[#39d5ff]/30">
               <TrendingUp className="h-4 w-4 text-[#39d5ff]" />
               <p className="font-mono text-[9px] uppercase leading-relaxed tracking-[0.1em] text-[#8fa3bd]">
                 viewing <span className="text-[#39d5ff] font-bold">{sportFilter.toUpperCase()}</span> performance. 
                 Official: {officialStats.wins}-{officialStats.losses} ({officialStats.strike?.toFixed(1)}%) | 
                 Community: {communityStats.wins}-{communityStats.losses} ({communityStats.strike?.toFixed(1)}%)
               </p>
             </Panel>
           </div>
        )}
      </div>

      {filtered.length === 0 && (
        <Panel className="p-10 text-center font-mono text-[12px] uppercase tracking-[0.2em] text-[#5f7089]">
          {viewMode === "official" ? "no official runs found" : viewMode === "community" ? "no community runs found" : "no runs yet — hit run the cluster in the war room"}
        </Panel>
      )}

      {/* ============ Run List ============ */}
      <div className="space-y-3">
        {sorted.map((r) => {
          const open = openId === r.id;
          const isAdmin = !!r.isViewerRun;
          const rp = r.predictions;
          // For per-run display, only count picks whose dedupeKey first appeared in THIS run
          const seenInRun = new Set();
          const uniqueRp = rp.filter((p) => {
            const k = p.dedupeKey || String(p.id);
            if (p.carried) return true; // carried = shown but not re-counted
            if (seenInRun.has(k)) return false;
            seenInRun.add(k);
            return true;
          });
          const rg = uniqueRp.filter((p) => p.outcome !== "pending" && !p.carried);
          const rw = rg.filter((p) => p.outcome === "win").length;
          const rl = rg.filter((p) => p.outcome === "loss").length;
          const rpnl = uniqueRp.filter((p) => !p.carried).reduce((s, p) => s + profit(p), 0);
          return (
            <Panel
              key={r.id}
              className={cx(
                "overflow-hidden",
                !isAdmin && "border-l-2 border-l-[#3d4c63]/50",
              )}
            >
              <button
                onClick={() => setOpenId(open ? null : r.id)}
                className={cx(
                  "flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 text-left transition",
                  isAdmin ? "hover:bg-white/[0.025]" : "hover:bg-white/[0.015] opacity-85",
                )}
              >
                <span className="font-mono text-[11px] font-bold text-[#3d4c63]">#{r.id}</span>
                {isAdmin
                  ? <Chip tone="magenta">Official</Chip>
                  : <Chip tone="slate">Community</Chip>}
                <span className={cx("font-display text-[15px] font-bold", isAdmin ? "text-[#e8f1fb]" : "text-[#8fa3bd]")}>{r.slateDate}</span>
                <span className="flex gap-1">
                  {r.sports.map((s) => (
                    <span key={s} className={cx("clip-tag border px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-[0.12em]", isAdmin ? "border-[#39d5ff]/25 bg-[#39d5ff]/8 text-[#39d5ff]" : "border-white/10 bg-white/[0.04] text-[#5f7089]")}>{s}</span>
                  ))}
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
                  </span>
                )}
                <ChevronDown className={cx("ml-auto h-4 w-4 text-[#5f7089] transition-transform", open && "rotate-180")} />
              </button>

              {open && (
                <div className={cx("border-t border-white/6 px-4 py-4", !isAdmin && "bg-white/[0.01]")}>
                  {r.council?.headline && (
                    <div className="mb-4 flex items-start gap-3 border-l-2 border-[#ff3d81]/50 pl-3">
                      <Target className="mt-0.5 h-4 w-4 shrink-0 text-[#ff3d81]" />
                      <div>
                        <div className={cx("font-display text-[14px] font-bold", isAdmin ? "text-[#e8f1fb]" : "text-[#8fa3bd]")}>{r.council.headline}</div>
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
                          {rp.map((p) => {
                            const firstStakeRun = p.dedupeKey ? firstStakes.get(p.dedupeKey) : null;
                            const isDuplicate = firstStakeRun && firstStakeRun.id !== r.id;
                            const firstWasAdmin = firstStakeRun?.isViewerRun;
                            
                            return (
                              <tr
                                key={p.id}
                                className={cx(
                                  "border-t border-white/5",
                                  isDuplicate ? "text-[#5f7089] opacity-50" :
                                  !isAdmin ? "text-[#8fa3bd]" : "text-[#b8c6da]",
                                )}
                              >
                                <td className="py-2 pr-3 text-[#3d4c63]">
                                  {isDuplicate ? (
                                    <span title={`already staked on run #${firstStakeRun?.id}`}>
                                      <Star className={cx("inline h-3 w-3", firstWasAdmin ? "text-[#ff3d81]" : "text-[#ffb020]")} />
                                    </span>
                                  ) : (
                                    p.sortOrder + 1
                                  )}
                                </td>
                                <td className="py-2 pr-3"><CategoryChip category={p.category} /></td>
                                <td className="max-w-[260px] py-2 pr-3">
                                  <span className={cx(
                                    "font-sans text-[12px] font-semibold",
                                    isDuplicate ? "text-[#5f7089] line-through" :
                                    !isAdmin ? "text-[#8fa3bd]" : "text-[#e8f1fb]",
                                  )}>
                                    {p.pick}
                                  </span>
                                  {isDuplicate && (
                                    <span className="ml-2 font-mono text-[8px] uppercase tracking-wider text-[#8fa3bd]">
                                      staked on #{firstStakeRun?.id} {firstWasAdmin ? "(Official)" : "(Community)"}
                                    </span>
                                  )}
                                </td>
                                <td className={cx("py-2 pr-3", !isAdmin ? "text-[#5f7089]" : "text-[#8fa3bd]")}>{p.matchup}</td>
                                <td className="py-2 pr-3 text-right text-[#ffb020]">{p.odds > 0 ? `+${p.odds}` : p.odds}</td>
                                <td className="py-2 pr-3 text-right text-[#39d5ff]">{p.confidence.toFixed(0)}</td>
                                <td className="py-2 pr-3 text-right">{p.units.toFixed(1)}u</td>
                                <td className="py-2 pr-3 text-right"><OutcomeChip outcome={p.outcome} /></td>
                                <td className="py-2 text-right text-[#5f7089]">{p.finalScore ?? "—"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#5f7089]">
                      {r.status === "running" ? "cluster still thinking" : "no bets released"}
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
          global prediction ledger · official runs (admin) appear on top in full color · community runs appear below in
          gray · ★ magenta star = community pick matches an official pick · ★ amber star = duplicate pick graded elsewhere
        </p>
        <CircleCheck className="ml-auto h-4 w-4 shrink-0 text-[#3d4c63]" />
      </Panel>
    </div>
  );
}
