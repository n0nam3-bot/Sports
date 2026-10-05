"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, Ban, Brain, CalendarDays, CheckCircle2, CircleDot, Cpu, Flame,
  Gauge, Loader2, Lock, Play, RefreshCw, ShieldAlert, Siren, Sparkles, Ticket,
  TrendingUp, Users2, XOctagon, Repeat, SlidersHorizontal, Shuffle, ToggleLeft, ToggleRight,
} from "lucide-react";
import type { GameC, PredC, RunC, SlateResp } from "./types";
import { CategoryChip, Chip, ConfBar, NeonButton, OutcomeChip, Panel, TeamMark, cx } from "./ui";
import { MARKET_OPTIONS, optionsForSports } from "@/lib/markets";

const LAYER_DOT: Record<string, string> = {
  scout: "#39d5ff",
  analyst: "#9d7bff",
  council: "#ff3d81",
  system: "#37ff8b",
};

function etTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
    });
  } catch { return "—"; }
}

function restTag(days: number, b2b: boolean, threein4: boolean, travel: boolean): { label: string; tone: string } | null {
  if (b2b) return { label: travel ? "B2B+TRVL" : "B2B", tone: "red" };
  if (threein4) return { label: "3-IN-4", tone: "amber" };
  if (days >= 2) return { label: `${days}D+ REST`, tone: "green" };
  if (days === 1) return { label: "STD REST", tone: "slate" };
  return null;
}

export default function WarRoom(props: {
  date: string;
  setDate: (d: string) => void;
  sports: string[];
  allSports: readonly { id: string; label: string; unavailable?: boolean }[];
  toggleSport: (id: string) => void;
  markets: string[];
  setMarkets: (m: string[]) => void;
  llmMode: "off" | "on";
  setLlmMode: (mode: "off" | "on") => void;
  excludedEvents: string[];
  setExcludedEvents: (ids: string[]) => void;
  slate: SlateResp | null;
  slateLoading: boolean;
  slateError?: string | null;
  reloadSlate: () => void;
  launch: () => void;
  running: boolean;
  launching?: boolean;
  activeRun: RunC | null;
  card: RunC | null;
}) {
  const { slate, activeRun, card } = props;
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeRun?.trace.length]);

  const showConsole = activeRun != null;
  const predictions = card?.status === "completed" ? card.predictions : [];
  const council = card?.council;
  const includedCount = useMemo(
    () => slate?.games.filter((g) => g.status === "pre" && !props.excludedEvents.includes(g.eventId)).length ?? 0,
    [slate, props.excludedEvents],
  );

  return (
    <div className="space-y-6">
      {/* ============ control deck ============ */}
      <Panel className="p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-4">
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-[#5f7089]">
              <CalendarDays className="h-3.5 w-3.5 text-[#39d5ff]" /> slate date
            </label>
            <input
              type="date"
              value={props.date}
              onChange={(e) => props.setDate(e.target.value)}
              className="clip-tag border border-[#39d5ff]/25 bg-[#0d1424] px-3.5 py-2.5 font-mono text-[13px] font-bold text-[#d7e3f0] outline-none transition focus:border-[#39d5ff]/60"
            />
          </div>

          <div>
            <label className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-[#5f7089]">
              <Users2 className="h-3.5 w-3.5 text-[#9d7bff]" /> sports feed
            </label>
            <div className="flex flex-wrap gap-1.5">
              {props.allSports.map((s) => {
                const on = props.sports.includes(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => props.toggleSport(s.id)}
                    title={s.unavailable ? "no free data feed exists for boxing" : undefined}
                    className={cx(
                      "clip-tag border px-3 py-2.5 font-mono text-[11px] font-bold tracking-[0.14em] transition-all",
                      s.unavailable
                        ? "cursor-not-allowed border-white/8 bg-white/[0.015] text-[#2f3b4d] line-through"
                        : on
                        ? "border-[#9d7bff]/45 bg-[#9d7bff]/14 text-[#9d7bff] shadow-[0_0_12px_-3px_rgba(157,123,255,0.5)]"
                        : "border-white/10 bg-white/[0.03] text-[#5f7089] hover:border-white/25 hover:text-[#8fa3bd]",
                    )}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="w-full">
            <label className="mb-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-[#5f7089]">
              <SlidersHorizontal className="h-3.5 w-3.5 text-[#ffb020]" /> market focus
              <span className="normal-case tracking-normal text-[#3d4c63]">
                — leave on mixed for a balanced card, or pick exactly what you want to bet
              </span>
            </label>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => props.setMarkets([])}
                className={cx(
                  "clip-tag flex items-center gap-1.5 border px-3 py-2 font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] transition-all",
                  props.markets.length === 0
                    ? "border-[#37ff8b]/45 bg-[#37ff8b]/14 text-[#37ff8b] shadow-[0_0_12px_-3px_rgba(55,255,139,0.5)]"
                    : "border-white/10 bg-white/[0.03] text-[#5f7089] hover:border-white/25 hover:text-[#8fa3bd]",
                )}
              >
                <Shuffle className="h-3.5 w-3.5" /> mixed (default)
              </button>
              {optionsForSports(props.sports).map((m) => {
                const on = props.markets.includes(m.id);
                return (
                  <button
                    key={m.id}
                    title={m.hint}
                    onClick={() =>
                      props.setMarkets(
                        on
                          ? props.markets.filter((x) => x !== m.id)
                          : [...props.markets, m.id],
                      )
                    }
                    className={cx(
                      "clip-tag border px-3 py-2 font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] transition-all",
                      on
                        ? "border-[#ffb020]/50 bg-[#ffb020]/14 text-[#ffb020] shadow-[0_0_12px_-3px_rgba(255,176,32,0.5)]"
                        : "border-white/10 bg-white/[0.03] text-[#5f7089] hover:border-white/25 hover:text-[#8fa3bd]",
                    )}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
            {props.markets.length > 0 && (
              <p className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#ffc966]">
                focused card — the council will only release {props.markets.length} selected market
                {props.markets.length === 1 ? "" : "s"} and will pass entirely if none carry an edge
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              onClick={() => props.setLlmMode(props.llmMode === "on" ? "off" : "on")}
              className={cx(
                "clip-tag flex items-center gap-2 border px-3 py-2 font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] transition-all",
                props.llmMode === "on"
                  ? "border-[#37ff8b]/45 bg-[#37ff8b]/12 text-[#37ff8b]"
                  : "border-[#39d5ff]/35 bg-[#39d5ff]/10 text-[#39d5ff]",
              )}
              title="Use saved AI keys only when you explicitly enable them"
            >
              {props.llmMode === "on" ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
              llm {props.llmMode === "on" ? "enabled" : "disabled"}
            </button>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#5f7089]">
              {includedCount} selected game{includedCount === 1 ? "" : "s"}
            </span>
          </div>

          <div className="mb-0.5 ml-auto flex flex-wrap items-center gap-2.5">
            <NeonButton tone="slate" onClick={props.reloadSlate} disabled={props.slateLoading}>
              <RefreshCw className={cx("h-3.5 w-3.5", props.slateLoading && "animate-spin")} />
              scan board
            </NeonButton>
            <NeonButton
              onClick={props.launch}
              disabled={props.running || props.launching || props.slateLoading || !slate || slate.counts.pre === 0}
              className="!px-7 !py-3 text-[13px]"
            >
              {props.launching || props.running ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> cluster running…</>
              ) : (
                <><Play className="h-4 w-4" /> run the cluster</>
              )}
            </NeonButton>
          </div>
        </div>

        {props.slateError && (
          <div className="mt-4 flex items-start gap-2.5 border border-[#ff4757]/30 bg-[#ff4757]/8 px-3.5 py-3">
            <XOctagon className="mt-0.5 h-4 w-4 shrink-0 text-[#ff4757]" />
            <div className="font-mono text-[10.5px] uppercase leading-relaxed tracking-[0.12em] text-[#ff8296]">
              slate fetch failed — {props.slateError}
              <div className="mt-1 text-[#8fa3bd] normal-case tracking-normal">
                Run the self-test at <span className="text-[#39d5ff]">/api/diag</span> to see whether the
                database, the sports feed, or the host is at fault.
              </div>
            </div>
          </div>
        )}

        {slate && slate.degraded && slate.degraded.length > 0 && (
          <div className="mt-4 flex items-center gap-2 border border-[#ffb020]/25 bg-[#ffb020]/8 px-3.5 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#ffc966]">
            <Gauge className="h-3.5 w-3.5 shrink-0" />
            partial intel: {slate.degraded.join(" · ")} — agents still run on everything available
          </div>
        )}

        {/* slate vitals */}
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/6 pt-3.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[#5f7089]">
          <span className="flex items-center gap-1.5"><CircleDot className="h-3 w-3 text-[#37ff8b]" />
            {slate ? `${slate.counts.pre} queued for analysis` : "board not scanned"}</span>
          <span className="flex items-center gap-1.5"><Siren className="h-3 w-3 text-[#ff3d81]" />
            {slate ? `${slate.counts.live} live — auto-skipped` : "—"}</span>
          <span className="flex items-center gap-1.5"><Lock className="h-3 w-3 text-[#ffb020]" />
            {slate ? `${slate.counts.final} final — auto-skipped` : "—"}</span>
          <span className="flex items-center gap-1.5"><Cpu className="h-3 w-3 text-[#37ff8b]" />
            {slate && slate.providers.length
              ? `swarm: ${slate.providers.join(" ・ ")}`
              : "swarm: built-in quant core — free, no keys needed. tap ADD AI KEYS up top to plug in your own gemini / grok / openrouter / ollama."}
          </span>
        </div>
      </Panel>

      {/* ============ kernel console ============ */}
      {props.launching && !activeRun && (
        <Panel className="panel-glow rise flex items-center gap-3 px-4 py-3.5">
          <Brain className="h-4 w-4 text-[#37ff8b] blink" />
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#5f7089]">
            dispatching agents — server cluster is booting the run (can take ~20-50s on hosted tiers)…
          </span>
        </Panel>
      )}
      {showConsole && activeRun && (
        <Panel className={cx("rise overflow-hidden", activeRun.status === "running" && "panel-glow")}>
          <div className="flex items-center justify-between border-b border-white/8 px-4 py-2.5">
            <div className="flex items-center gap-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-[#5f7089]">
              <Brain className={cx("h-4 w-4 text-[#37ff8b]", activeRun.status === "running" && "blink")} />
              agent mesh // run #{activeRun.id} — {activeRun.slateDate}
              <Chip tone={activeRun.mode === "llm" ? "green" : "cyan"}>{activeRun.mode === "llm" ? "LLM SWARM" : "QUANT CORE"}</Chip>
            </div>
            <span className={cx("font-mono text-[10px] font-bold uppercase tracking-[0.18em]",
              activeRun.status === "running" ? "text-[#ffb020] blink" : activeRun.status === "completed" ? "text-[#37ff8b]" : "text-[#ff4757]")}>
              {activeRun.status === "running" ? "● processing" : activeRun.status}
            </span>
          </div>
          <div ref={consoleRef} className="max-h-[330px] space-y-1.5 overflow-y-auto px-4 py-3.5 font-mono text-[11.5px] leading-relaxed">
            {activeRun.trace.map((t, i) => (
              <div key={i} className="trace-line flex items-start gap-2.5" style={{ animationDelay: "0ms" }}>
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: LAYER_DOT[t.layer] ?? "#37ff8b" }} />
                <span className="shrink-0 font-bold uppercase tracking-[0.1em]" style={{ color: LAYER_DOT[t.layer] ?? "#37ff8b" }}>
                  [{t.agent}]
                </span>
                <span className={cx("text-[#b8c6da]", t.mood === "warn" && "text-[#ffb020]", t.mood === "error" && "text-[#ff4757]")}>
                  {t.message}
                </span>
              </div>
            ))}
            {activeRun.status === "running" && (
              <div className="flex items-center gap-2 pt-1 text-[#5f7089]">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span className="blink">agents conferring…</span>
              </div>
            )}
          </div>
        </Panel>
      )}

      {/* ============ the slip ============ */}
      {council && predictions.length > 0 && (
        <section className="rise space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Ticket className="h-6 w-6 text-[#37ff8b]" />
            <h2 className="font-display text-2xl font-bold uppercase tracking-tight title-stroke">
              The Slip <span className="text-[#37ff8b]">// top {predictions.length}</span>
            </h2>
            <Chip tone="green"><Flame className="h-3 w-3" /> council approved</Chip>
          </div>

          <Panel className="panel-glow p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-3xl">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-[#ff3d81]">commissioner&apos;s verdict</div>
                <h3 className="mt-1 font-display text-xl font-bold text-[#d7e3f0]">{council.headline}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-[#8fa3bd]">{council.memo}</p>
              </div>
              <div className="flex gap-5 font-mono text-right text-[11px]">
                <div>
                  <div className="text-[9px] uppercase tracking-[0.2em] text-[#5f7089]">exposure</div>
                  <div className="text-xl font-bold text-[#37ff8b]">{predictions.reduce((s, p) => s + p.units, 0).toFixed(1)}u</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase tracking-[0.2em] text-[#5f7089]">avg conf</div>
                  <div className="text-xl font-bold text-[#39d5ff]">{(predictions.reduce((s, p) => s + p.confidence, 0) / predictions.length).toFixed(0)}</div>
                </div>
              </div>
            </div>
            {!!council.repeats?.length && (
              <div className="mt-3 border-t border-white/6 pt-3">
                <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-[#39d5ff]">
                  <Repeat className="h-3.5 w-3.5" /> already on your ledger — not re-staked
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {council.repeats.slice(0, 8).map((r, i) => (
                    <span
                      key={i}
                      className="clip-tag border border-[#39d5ff]/20 bg-[#39d5ff]/6 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-[#7fd4f5]"
                      title={`first released on run #${r.firstRunId} — counts once`}
                    >
                      {r.pick} · run #{r.firstRunId} · {r.outcome}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {!!council.avoided?.length && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-white/6 pt-3">
                <span className="mr-1 flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-[#ff4757]">
                  <ShieldAlert className="h-3 w-3" /> faded by council:
                </span>
                {council.avoided.slice(0, 6).map((a) => (
                  <span key={a} className="clip-tag border border-[#ff4757]/20 bg-[#ff4757]/5 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-[#ff8296]">{a}</span>
                ))}
              </div>
            )}
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            {predictions.map((p, i) => (
              <BetCard key={p.id} rank={i + 1} p={p} />
            ))}
          </div>
        </section>
      )}

      {council && predictions.length === 0 && card?.status === "completed" && (
        <Panel className="rise flex items-start gap-3 p-5">
          <Ban className="mt-0.5 h-5 w-5 shrink-0 text-[#ffb020]" />
          <div>
            <div className="font-display text-lg font-bold">{council.headline}</div>
            <div className="text-[13px] text-[#8fa3bd]">{council.memo}</div>
            {props.sports.some((s) => ["ufc", "dwcs", "pfl"].includes(s)) && (
              <div className="mt-2 text-[12px] leading-relaxed text-[#5f7089]">
                Prospect cards like DWCS routinely match undefeated fighters against each other, so the
                model lands near a coin-flip and correctly declines to force a side. Round and method
                angles are still shown on each bout above.
              </div>
            )}
          </div>
        </Panel>
      )}

      {/* ============ slate board ============ */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Activity className="h-6 w-6 text-[#39d5ff]" />
          <h2 className="font-display text-2xl font-bold uppercase tracking-tight title-stroke">
            Tonight&apos;s Board
          </h2>
          {slate && <Chip tone="cyan">{slate.counts.total} games scanned</Chip>}
          {props.slateLoading && <Loader2 className="h-4 w-4 animate-spin text-[#39d5ff]" />}
        </div>

        {!slate && !props.slateLoading && (
          <Panel className="p-8 text-center font-mono text-[12px] uppercase tracking-[0.2em] text-[#5f7089]">
            select date + sports · hit scan board
          </Panel>
        )}
        {slate && slate.games.length === 0 && (
          <Panel className="p-8 text-center">
            <XOctagon className="mx-auto mb-2 h-6 w-6 text-[#ffb020]" />
            <div className="font-mono text-[12px] uppercase tracking-[0.2em] text-[#8fa3bd]">
              no games scheduled for {props.date} in {props.sports.map((s) => s.toUpperCase()).join(" / ")}
            </div>
            <div className="mx-auto mt-3 max-w-xl text-[12px] leading-relaxed text-[#5f7089]">
              This is the league&apos;s calendar, not an error — off-day or off-season. Leagues run:
              <span className="text-[#39d5ff]"> NFL/NCAAF</span> Sep–Jan ·
              <span className="text-[#9d7bff]"> NBA/NCAAB/NHL</span> Oct–Jun ·
              <span className="text-[#ffb020]"> MLB</span> Mar–Oct. Try tomorrow&apos;s date, or select
              several sports at once to find a live board.
            </div>
          </Panel>
        )}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {slate?.games.map((g) => (
            <GameCard
              key={`${g.sport}-${g.eventId}`}
              g={g}
              excluded={props.excludedEvents.includes(g.eventId)}
              toggleExcluded={() =>
                props.setExcludedEvents(
                  props.excludedEvents.includes(g.eventId)
                    ? props.excludedEvents.filter((id) => id !== g.eventId)
                    : [...props.excludedEvents, g.eventId],
                )
              }
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/* ================= bet card ================= */

function BetCard({ rank, p }: { rank: number; p: PredC }) {
  const hot = rank <= 3 && p.outcome === "pending";
  return (
    <Panel className={cx("rise flex flex-col gap-3 p-4", hot && "panel-glow")} >
      <div className="flex items-center gap-3">
        <span className={cx(
          "font-display text-[34px] font-bold leading-none",
          rank <= 3 ? "text-[#37ff8b]" : "text-[#2b3a52]",
          p.outcome === "win" && "text-[#37ff8b]",
          p.outcome === "loss" && "text-[#ff4757]/70",
        )}>
          {String(rank).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <CategoryChip category={p.category} />
          <div className="mt-1 truncate font-display text-[15px] font-bold leading-snug text-[#e8f1fb]">{p.pick}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <OutcomeChip outcome={p.outcome} />
          {p.carried && (
            <span
              className="clip-tag border border-[#39d5ff]/25 bg-[#39d5ff]/8 px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-[0.12em] text-[#7fd4f5]"
              title="already staked on an earlier run — shown here but graded once"
            >
              already staked
            </span>
          )}
          {p.isDuplicate && p.canonRunId && (
            <span
              className="clip-tag border border-[#5f7089]/30 bg-[#5f7089]/8 px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-[0.12em] text-[#8fa3bd]"
              title={`same pick as run #${p.canonRunId} — graded there, not here`}
            >
              ★ same as run #{p.canonRunId}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#5f7089]">
        <span className="text-[#d7e3f0]">{p.matchup}</span>
        <span>{etTime(p.startTime)} ET</span>
        <span className="text-[#ffb020]">odds {p.odds > 0 ? `+${p.odds}` : p.odds}</span>
        <span className="text-[#37ff8b]">{p.units.toFixed(1)}u stake</span>
      </div>

      <ConfBar value={p.confidence} />

      <p className="text-[12px] leading-relaxed text-[#8fa3bd]">{p.reasoning}</p>

      <div className="flex flex-wrap items-center gap-1 border-t border-white/6 pt-2.5">
        <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.2em] text-[#3d4c63]">stamped by</span>
        {p.agents.slice(0, 7).map((a) => (
          <span key={a} className="clip-tag border border-white/10 bg-white/[0.04] px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-[0.12em] text-[#8fa3bd]">{a}</span>
        ))}
        {p.finalScore && (
          <span className="ml-auto flex items-center gap-1 font-mono text-[10px] font-bold text-[#5f7089]">
            <CheckCircle2 className="h-3 w-3 text-[#37ff8b]" /> {p.finalScore}
          </span>
        )}
      </div>
    </Panel>
  );
}

/* ================= game card ================= */

function GameCard({
  g,
  excluded,
  toggleExcluded,
}: {
  g: GameC;
  excluded: boolean;
  toggleExcluded: () => void;
}) {
  const dead = g.status !== "pre";
  const o = g.odds;
  const homeRest = g.rest ? restTag(g.rest.homeDays, g.rest.homeB2B, g.rest.home3in4, g.rest.homeTravel) : null;
  const awayRest = g.rest ? restTag(g.rest.awayDays, g.rest.awayB2B, g.rest.away3in4, g.rest.awayTravel) : null;

  return (
    <Panel className={cx("relative overflow-hidden p-4", dead && "opacity-60 saturate-50")}>
      {/* header */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-[#39d5ff]">{g.sportLabel}</span>
          {g.status === "pre" && (
            <button
              onClick={toggleExcluded}
              className={cx(
                "clip-tag border px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-[0.14em] transition-all",
                excluded
                  ? "border-[#ff4757]/35 bg-[#ff4757]/10 text-[#ff8296]"
                  : "border-[#37ff8b]/30 bg-[#37ff8b]/8 text-[#37ff8b]",
              )}
              title={excluded ? "excluded from analysis" : "included in analysis"}
            >
              {excluded ? "excluded" : "included"}
            </button>
          )}
        </div>
        {g.status === "pre" ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#5f7089]">{etTime(g.startTime)} ET</span>
        ) : g.status === "in" ? (
          <span className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#ff3d81]">
            <span className="blink h-1.5 w-1.5 rounded-full bg-[#ff3d81]" /> live — skipped
          </span>
        ) : (
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#ffb020]">{g.statusDetail || "final"} — skipped</span>
        )}
      </div>

      {/* teams */}
      <div className="space-y-2.5">
        {[
          { t: g.away, ml: o?.awayML, rest: awayRest, away: true },
          { t: g.home, ml: o?.homeML, rest: homeRest, away: false },
        ].map(({ t, ml, rest, away }) => (
          <div key={t.abbr + away} className="flex items-center gap-3">
            {g.combat ? (
              <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full border border-[#ff3d81]/25 bg-[#ff3d81]/8 font-mono text-[10px] font-bold text-[#ff3d81]">
                {away ? "A" : "B"}
              </span>
            ) : (
              <TeamMark src={t.logo} abbr={t.abbr} size={38} />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-display text-[14.5px] font-bold text-[#e8f1fb]">{t.name}</span>
                {rest && <Chip tone={rest.tone} className="!px-1.5 !text-[8.5px]">{rest.label}</Chip>}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#5f7089]">
                {t.record}{away && t.awayRecord ? ` · road ${t.awayRecord}` : ""}{!away && t.homeRecord ? ` · home ${t.homeRecord}` : ""}
              </div>
            </div>
            {g.combat ? (
              (() => {
                const fm = away ? g.combat.model.fairAwayML : g.combat.model.fairHomeML;
                const pr = away ? g.combat.model.pAway : g.combat.model.pHome;
                return (
                  <span className="text-right">
                    <span className={cx("block font-mono text-[12px] font-bold", fm < 0 ? "text-[#37ff8b]" : "text-[#8fa3bd]")}>
                      {fm > 0 ? `+${fm}` : fm}
                    </span>
                    <span className="block font-mono text-[8.5px] uppercase tracking-[0.1em] text-[#3d4c63]">
                      {(pr * 100).toFixed(0)}% model
                    </span>
                  </span>
                );
              })()
            ) : ml != null ? (
              <span className={cx("font-mono text-[12px] font-bold", ml < 0 ? "text-[#37ff8b]" : "text-[#8fa3bd]")}>
                {ml > 0 ? `+${ml}` : ml}
              </span>
            ) : null}
          </div>
        ))}
      </div>

      {/* market strip */}
      {g.combat ? (
        <>
          <div className="mt-3 grid grid-cols-4 gap-1.5 border-t border-white/6 pt-3 font-mono text-center">
            <div className="rounded bg-white/[0.03] px-1 py-1.5">
              <div className="text-[8.5px] uppercase tracking-[0.18em] text-[#3d4c63]">division</div>
              <div className="text-[10px] font-bold text-[#ff3d81]">{g.combat.weightClass}</div>
            </div>
            <div className="rounded bg-white/[0.03] px-1 py-1.5">
              <div className="text-[8.5px] uppercase tracking-[0.18em] text-[#3d4c63]">rounds</div>
              <div className="text-[10px] font-bold text-[#9d7bff]">{g.combat.scheduledRounds}</div>
            </div>
            <div className="rounded bg-white/[0.03] px-1 py-1.5" title="model price that the fight ends inside the distance">
              <div className="text-[8.5px] uppercase tracking-[0.18em] text-[#3d4c63]">finish</div>
              <div className="text-[10px] font-bold text-[#37ff8b]">
                {g.combat.model.fairFinish > 0 ? `+${g.combat.model.fairFinish}` : g.combat.model.fairFinish}
              </div>
            </div>
            <div className="rounded bg-white/[0.03] px-1 py-1.5" title="model price on the round total">
              <div className="text-[8.5px] uppercase tracking-[0.18em] text-[#3d4c63]">o{g.combat.model.roundLine} rds</div>
              <div className="text-[10px] font-bold text-[#39d5ff]">
                {g.combat.model.fairRoundsOver > 0 ? `+${g.combat.model.fairRoundsOver}` : g.combat.model.fairRoundsOver}
              </div>
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-1 font-mono text-[8.5px] uppercase tracking-[0.14em] text-[#5f7089]">
            <Gauge className="h-3 w-3 text-[#ffb020]" />
            model prices — no sportsbook publishes MMA lines on the free feed
          </div>
        </>
      ) : (
      <div className="mt-3 grid grid-cols-3 gap-1.5 border-t border-white/6 pt-3 font-mono text-center">
        <div className="rounded bg-white/[0.03] px-1 py-1.5">
          <div className="text-[8.5px] uppercase tracking-[0.18em] text-[#3d4c63]">spread</div>
          <div className="text-[11px] font-bold text-[#39d5ff]">{o?.details || "—"}</div>
        </div>
        <div className="rounded bg-white/[0.03] px-1 py-1.5">
          <div className="text-[8.5px] uppercase tracking-[0.18em] text-[#3d4c63]">total</div>
          <div className="text-[11px] font-bold text-[#9d7bff]">{o?.overUnder ?? "—"}</div>
        </div>
        <div className="rounded bg-white/[0.03] px-1 py-1.5">
          <div className="text-[8.5px] uppercase tracking-[0.18em] text-[#3d4c63]">tm totals</div>
          <div className="text-[11px] font-bold text-[#8fa3bd]">
            {o?.homeTeamTotal != null ? `${o.awayTeamTotal ?? "?"}/${o.homeTeamTotal}` : "—"}
          </div>
        </div>
      </div>
      )}

      {/* pregame context */}
      {(g.context.awayProbables.length > 0 || g.context.homeProbables.length > 0 || g.context.notes.length > 0) && (
        <div className="mt-2.5 space-y-1.5 border-t border-white/6 pt-2.5">
          {g.context.awayProbables.length > 0 || g.context.homeProbables.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {g.context.awayProbables.map((p) => (
                <span key={`a-${p.name}`} className="clip-tag border border-[#39d5ff]/20 bg-[#39d5ff]/8 px-1.5 py-px font-mono text-[8.5px] uppercase tracking-wider text-[#7fd4f5]" title={p.record || p.role}>
                  {g.away.abbr} {p.position || p.role}: {p.shortName}{p.record ? ` ${p.record}` : ""}
                </span>
              ))}
              {g.context.homeProbables.map((p) => (
                <span key={`h-${p.name}`} className="clip-tag border border-[#39d5ff]/20 bg-[#39d5ff]/8 px-1.5 py-px font-mono text-[8.5px] uppercase tracking-wider text-[#7fd4f5]" title={p.record || p.role}>
                  {g.home.abbr} {p.position || p.role}: {p.shortName}{p.record ? ` ${p.record}` : ""}
                </span>
              ))}
            </div>
          ) : null}
          {g.context.notes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {g.context.notes.slice(0, 3).map((n) => (
                <span key={n} className="clip-tag border border-white/10 bg-white/[0.04] px-1.5 py-px font-mono text-[8.5px] uppercase tracking-wider text-[#8fa3bd]">
                  {n}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* injuries */}
      <InjuryList injuries={g.injuries} />

      {dead && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-gradient-to-t from-[#03050b]/95 to-transparent pb-1.5 pt-6 font-mono text-[9px] font-bold uppercase tracking-[0.26em] text-[#5f7089]">
          <Gauge className="h-3 w-3" /> cluster conserves compute — no dead-game analysis
        </div>
      )}
    </Panel>
  );
}

/* ================= expandable injury list ================= */

function InjuryList({ injuries }: { injuries: { team: string; player: string; status: string; detail: string }[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!injuries.length) return null;
  const shown = expanded ? injuries : injuries.slice(0, 3);
  const hasMore = injuries.length > 3;
  return (
    <div className="mt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <ShieldAlert className="h-3 w-3 text-[#ffb020]" />
        {shown.map((inj) => (
          <span
            key={inj.player}
            className="clip-tag border border-[#ffb020]/20 bg-[#ffb020]/8 px-1.5 py-px font-mono text-[8.5px] uppercase tracking-wider text-[#ffc966]"
            title={`${inj.player} — ${inj.status}${inj.detail ? ` (${inj.detail})` : ""}`}
          >
            {inj.player} · {inj.status}{inj.detail ? ` · ${inj.detail}` : ""}
          </span>
        ))}
        {hasMore && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="font-mono text-[9px] uppercase text-[#39d5ff] hover:text-[#7fd4f5] transition"
          >
            {expanded ? "show less" : `+${injuries.length - 3} more — tap to expand`}
          </button>
        )}
      </div>
    </div>
  );
}
