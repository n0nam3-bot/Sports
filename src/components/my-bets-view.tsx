"use client";

import { useMemo, useState } from "react";
import { BetControl, type BetSavePayload } from "./bet-control";
import { getOwnerId, ownerFetch, setOwnerId } from "./keys";
import type { BetC, BetResult, BetSummaryC } from "./types";
import { CategoryChip, Chip, cx, fmtOdds, NeonButton, OutcomeChip, Panel } from "./ui";

interface Props {
  bets: BetC[];
  summary: BetSummaryC | null;
  loading: boolean;
  error: string | null;
  syncing: boolean;
  onSync: () => void;
  onSave: (p: BetSavePayload) => Promise<string | null>;
  onRemove: (predictionId: number) => Promise<void>;
  onResult: (predictionId: number, result: Exclude<BetResult, "pending"> | null) => Promise<string | null>;
}

const fmtU = (n: number, digits = 2): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}u`;
const pctStr = (n: number | null, digits = 1): string => (n == null ? "—" : `${(n * 100).toFixed(digits)}%`);
const tone = (n: number | null): string => (n == null || n === 0 ? "text-slate-200" : n > 0 ? "text-[#37ff8b]" : "text-[#ff4757]");

function Tile({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-gradient-to-b from-[#101a30] to-[#0a1020] px-4 py-3.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#5f7089]">{label}</div>
      <div className={cx("mt-1 font-mono text-[26px] font-bold leading-none", valueClass ?? "text-slate-100")}>{value}</div>
      {sub && <div className="mt-1.5 font-mono text-[10px] leading-snug text-[#8fa3bd]">{sub}</div>}
    </div>
  );
}

const MARKET_LABEL: Record<string, string> = {
  spread: "Spread", total: "Game total", moneyline: "Moneyline", team_total: "Team total", player_prop: "Player prop",
  fight_ml: "Fight winner", fight_rounds: "Total rounds", fight_distance: "Goes distance", fight_start_round: "Starts round",
  fight_spread: "Finish spread", fight_method_win: "Method", fight_sigstr: "Sig strikes", fight_td: "Takedowns", fight_method: "Finish / decision",
};

export function MyBetsView({ bets, summary, loading, error, syncing, onSync, onSave, onRemove, onResult }: Props) {
  const [filter, setFilter] = useState<"all" | "pending" | "settled">("all");
  const [restore, setRestore] = useState("");
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);

  const shown = useMemo(
    () => bets.filter((b) => (filter === "all" ? true : filter === "pending" ? b.result === "pending" : b.result !== "pending")),
    [bets, filter],
  );

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await ownerFetch("/api/bets?format=csv");
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "my-bets.csv";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(getOwnerId());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  };

  const doRestore = () => {
    if (setOwnerId(restore)) {
      setRestoreMsg("Workspace restored — reloading…");
      setTimeout(() => window.location.reload(), 600);
    } else {
      setRestoreMsg("That doesn't look like a workspace id (8–64 letters, numbers, - or _).");
    }
  };

  const s = summary;
  const decided = s ? s.wins + s.losses : 0;

  return (
    <div className="space-y-6">
      {/* ---------- header ---------- */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-display text-[28px] font-bold uppercase tracking-tight text-slate-100">My Bets</h2>
        <Chip tone="green">{bets.length} TRACKED</Chip>
        <span className="font-mono text-[11px] text-[#8fa3bd]">only what you actually bet, at the price you actually got</span>
      </div>
      <NeonButton onClick={onSync} disabled={syncing} className="w-full sm:w-auto">
        {syncing ? "grading…" : "⟳ sync & grade"}
      </NeonButton>

      {error && <Panel className="p-4"><div className="font-mono text-[12px] text-[#ff4757]">{error}</div></Panel>}

      {/* ---------- empty ---------- */}
      {!loading && bets.length === 0 && !error && (
        <Panel className="p-6">
          <div className="font-display text-[18px] font-bold uppercase text-slate-100">Nothing tracked yet</div>
          <p className="mt-2 max-w-xl font-mono text-[12px] leading-relaxed text-[#8fa3bd]">
            Nobody places every pick, and nobody gets exactly the suggested price. Tap <b className="text-[#37ff8b]">+ I bet this</b> on any
            pick in the War Room or the Ledger, enter the stake and odds you really used, and your own unit gain shows up here — graded
            automatically when the result is in.
          </p>
        </Panel>
      )}

      {/* ---------- summary ---------- */}
      {s && bets.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Tile label="My record" value={`${s.wins}–${s.losses}${s.pushes ? `–${s.pushes}` : ""}`} sub={decided ? `${pctStr(s.winRate)} win rate` : "nothing settled yet"} />
            <Tile label="My units P/L" value={fmtU(s.pnl, 1)} valueClass={tone(s.pnl)} sub={s.roi != null ? `${s.roi >= 0 ? "+" : ""}${(s.roi * 100).toFixed(1)}% ROI on ${s.staked}u staked` : "no settled bets"} />
            <Tile label="At risk now" value={`${s.atRisk}u`} valueClass="text-[#ffb020]" sub={`${s.pending} pending bet${s.pending === 1 ? "" : "s"}`} />
          </div>

          {s.vsFollowAll != null && s.followAllBets > 0 && (
            <Panel className="p-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#5f7089]">your picks vs following every pick</div>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <span className={cx("font-mono text-[22px] font-bold", tone(s.vsFollowAll))}>{fmtU(s.vsFollowAll, 1)}</span>
                <span className="font-mono text-[11px] leading-relaxed text-[#8fa3bd]">
                  Betting all {s.followAllBets} settled picks on the days you played, at the suggested stakes and prices, would have made{" "}
                  <b className={tone(s.followAllPnl)}>{fmtU(s.followAllPnl ?? 0, 1)}</b>. You made <b className={tone(s.pnl)}>{fmtU(s.pnl, 1)}</b>.
                  {s.vsFollowAll >= 0 ? " Your selection is adding value." : " Following the whole card would have done better so far."}
                </span>
              </div>
            </Panel>
          )}

          {(s.bySport.length > 0 || s.byCategory.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {[{ title: "By sport", rows: s.bySport, label: (k: string) => k.toUpperCase() }, { title: "By market", rows: s.byCategory, label: (k: string) => MARKET_LABEL[k] ?? k }].map((blk) => (
                <Panel key={blk.title} className="p-4">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#5f7089]">{blk.title}</div>
                  <div className="mt-2 space-y-1.5">
                    {blk.rows.slice(0, 8).map((r) => (
                      <div key={r.key} className="flex items-center justify-between font-mono text-[12px]">
                        <span className="text-slate-200">{blk.label(r.key)}</span>
                        <span className="flex items-center gap-3">
                          <span className="text-[#8fa3bd]">{r.wins}–{r.losses}</span>
                          <span className={cx("w-16 text-right font-bold", tone(r.pnl))}>{fmtU(r.pnl, 1)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </Panel>
              ))}
            </div>
          )}
        </>
      )}

      {/* ---------- list ---------- */}
      {bets.length > 0 && (
        <div className="space-y-3">
          <div className="flex gap-2">
            {(["all", "pending", "settled"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cx(
                  "clip-tag border px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.16em] transition",
                  filter === f ? "border-[#37ff8b]/40 bg-[#37ff8b]/10 text-[#37ff8b]" : "border-white/10 text-[#8fa3bd] hover:text-slate-200",
                )}
              >
                {f}
              </button>
            ))}
          </div>

          {shown.map((b) => (
            <Panel key={b.id} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <CategoryChip category={b.prediction.category} />
                <Chip tone="slate">{b.prediction.sport.toUpperCase()}</Chip>
                <span className="font-mono text-[11px] text-[#8fa3bd]">{b.prediction.slateDate}</span>
                <span className="ml-auto flex items-center gap-2">
                  <OutcomeChip outcome={b.result} />
                  {b.result !== "pending" && (
                    <span className={cx("font-mono text-[14px] font-bold", tone(b.pnl))}>{fmtU(b.pnl)}</span>
                  )}
                </span>
              </div>
              <div className="mt-2 font-display text-[17px] font-bold leading-snug text-slate-100">{b.prediction.pick}</div>
              <div className="font-mono text-[11px] text-[#8fa3bd]">{b.prediction.matchup}</div>
              {b.prediction.finalScore && <div className="mt-1 font-mono text-[11px] text-[#5f7089]">result: {b.prediction.finalScore}</div>}

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-[#8fa3bd]">
                <span>
                  you: <b className="text-slate-100">{b.stake}u @ {fmtOdds(b.odds)}</b>
                </span>
                <span>
                  suggested: {b.prediction.units}u @ {fmtOdds(b.prediction.odds)}
                  {b.prediction.priceSource === "model" ? " (model price)" : ""}
                </span>
                {b.evAtPrice != null && (
                  <span className={b.evAtPrice >= 0 ? "text-[#37ff8b]" : "text-[#ff4757]"}>
                    EV at your price {b.evAtPrice >= 0 ? "+" : ""}{(b.evAtPrice * 100).toFixed(1)}%
                  </span>
                )}
              </div>
              {b.note && <div className="mt-1 font-mono text-[11px] italic text-[#5f7089]">“{b.note}”</div>}

              <BetControl
                pick={{ id: b.predictionId, odds: b.prediction.odds, units: b.prediction.units, outcome: b.prediction.outcome, modelProb: b.prediction.modelProb, priceSource: b.prediction.priceSource, minPrice: b.prediction.minPrice }}
                bet={b}
                onSave={onSave}
                onRemove={onRemove}
              />

              {/* manual settlement */}
              <details className="mt-3 border-t border-white/5 pt-2">
                <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.16em] text-[#5f7089] hover:text-[#8fa3bd]">
                  settle this bet manually
                </summary>
                <p className="mt-2 font-mono text-[11px] leading-relaxed text-[#8fa3bd]">
                  For when your book voided it, or you took a different line than the pick. Affects only your tracker, never the shared ledger.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(["win", "loss", "push", "void"] as const).map((r) => (
                    <button
                      key={r}
                      onClick={() => onResult(b.predictionId, r)}
                      className={cx("rounded border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em]", b.override === r ? "border-[#ffb020]/50 bg-[#ffb020]/10 text-[#ffb020]" : "border-white/10 text-[#8fa3bd] hover:text-slate-200")}
                    >
                      {r}
                    </button>
                  ))}
                  <button onClick={() => onResult(b.predictionId, null)} className="rounded border border-white/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#39d5ff]">
                    follow graded result
                  </button>
                </div>
              </details>
            </Panel>
          ))}
          {shown.length === 0 && <div className="font-mono text-[12px] text-[#8fa3bd]">No {filter} bets.</div>}
        </div>
      )}

      {/* ---------- data safety ---------- */}
      <Panel className="p-4">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#5f7089]">keep your record safe</div>
        <p className="mt-2 font-mono text-[11px] leading-relaxed text-[#8fa3bd]">
          Your bets are filed under a private workspace id stored in this browser. If you clear browser data or switch phones, you&apos;d lose access
          to them. Export a CSV any time, or copy your id and paste it on another device to pick up where you left off. Treat the id like a
          password — anyone holding it can see and edit your tracker.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={exportCsv} disabled={exporting || bets.length === 0} className="clip-tag border border-[#39d5ff]/30 bg-[#39d5ff]/10 px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#39d5ff] disabled:opacity-35">
            {exporting ? "exporting…" : "↓ export csv"}
          </button>
          <button onClick={copyId} className="clip-tag border border-white/15 px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-slate-200">
            {copied ? "copied ✓" : "copy my workspace id"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={restore}
            onChange={(e) => setRestore(e.target.value)}
            placeholder="paste a workspace id to restore it here"
            aria-label="workspace id to restore"
            autoCapitalize="off"
            autoCorrect="off"
            className="min-w-0 flex-1 rounded border border-white/10 bg-[#0d1424] px-2.5 py-2 font-mono text-[12px] text-slate-100 placeholder:text-[#5f7089] outline-none focus:border-[#39d5ff]/50"
          />
          <button onClick={doRestore} disabled={!restore.trim()} className="clip-tag border border-[#ffb020]/30 bg-[#ffb020]/10 px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#ffb020] disabled:opacity-35">
            restore
          </button>
        </div>
        {restoreMsg && <div className="mt-2 font-mono text-[11px] text-[#8fa3bd]">{restoreMsg}</div>}
      </Panel>
    </div>
  );
}
