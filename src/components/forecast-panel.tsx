"use client";

import { useEffect, useState } from "react";
import { Crosshair } from "lucide-react";
import type { ForecastC, RunC } from "./types";
import { Chip, Panel, cx } from "./ui";

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const pts = (x: number): string => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)} pts`;
const SHOWN = 8;

/** What, if anything, the card above did with this game. A forecast is never a bet by itself. */
function stakeOn(card: RunC | null, eventId: string): { label: string; tone: string } {
  const picks = (card?.predictions ?? []).filter((p) => p.eventId === eventId);
  const plays = picks.filter((p) => p.units > 0);
  if (plays.length) return { label: `BET ${Number(plays.reduce((s, p) => s + p.units, 0).toFixed(2))}u`, tone: "green" };
  if (picks.length) return { label: "LEAN", tone: "violet" };
  return { label: "no bet", tone: "slate" };
}

/**
 * A prediction for every game the engine could price — our win probability for the side we favour, next to the
 * vig-free market's — whether or not anything is worth betting. Most games have no edge, and that is the point.
 */
export default function ForecastPanel({
  date,
  sports,
  card,
  boardCount,
}: {
  date: string;
  sports: string[];
  card: RunC | null;
  /** games still to be played on the board, when known */
  boardCount: number | null;
}) {
  const sportsKey = [...sports].sort().join(",");
  const base = `${date}|${sportsKey}`;
  const runId = card?.id ?? 0; // a finished run writes new forecasts, so it triggers a reload
  // Loaded rows are tagged with the slate they belong to; "loading" is simply "nothing loaded for this slate yet".
  const [loaded, setLoaded] = useState<{ base: string; rows: ForecastC[]; error: string | null } | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!sportsKey) return;
    let alive = true;
    fetch(`/api/forecasts?date=${date}&sports=${sportsKey}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
        return (j.forecasts ?? []) as ForecastC[];
      })
      .then((rows) => {
        if (alive) setLoaded({ base, rows, error: null });
      })
      .catch((e: unknown) => {
        if (alive) setLoaded({ base, rows: [], error: e instanceof Error ? e.message : "could not load forecasts" });
      });
    return () => {
      alive = false;
    };
  }, [date, sportsKey, base, runId]);

  if (!sportsKey) return null;
  const shown = loaded && loaded.base === base ? loaded : null;
  const rows = shown?.rows ?? [];
  const visible = expanded ? rows : rows.slice(0, SHOWN);
  const finished = rows.filter((f) => f.outcome === "win" || f.outcome === "loss");
  const right = finished.filter((f) => f.outcome === "win").length;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Crosshair className="h-6 w-6 text-[#37ff8b]" />
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight title-stroke">
          All Games <span className="text-[#37ff8b]">{"//"} forecast</span>
        </h2>
        {shown && !shown.error && (
          <Chip tone="green">
            {rows.length}
            {boardCount != null ? ` of ${boardCount}` : ""} game{rows.length === 1 ? "" : "s"}
          </Chip>
        )}
        {finished.length > 0 && (
          <Chip tone={right / finished.length >= 0.5 ? "green" : "amber"}>
            right on {right} of {finished.length} finished
          </Chip>
        )}
        <Chip tone="amber">not bets</Chip>
      </div>
      <p className="font-mono text-[10px] leading-relaxed tracking-[0.04em] text-[#5f7089]">
        A forecast is a prediction, not a bet. For every game we can price we name the side we favour, next to the vig-free market&apos;s own number.
        Most games have no edge — that is normal, and it is why the card above passes on them. A stake exists only where it says{" "}
        <b className="text-[#37ff8b]">BET</b>. How accurate these are is tracked on the <b className="text-[#8fa3bd]">Scoreboard</b>.
      </p>

      <Panel className="overflow-hidden">
        {!shown && <div className="p-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-[#5f7089]">loading forecasts…</div>}
        {shown?.error && <div className="p-6 text-center font-mono text-[11px] text-[#ff4757]">couldn&apos;t load forecasts — {shown.error}</div>}
        {shown && !shown.error && rows.length === 0 && (
          <div className="p-6 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-[#5f7089]">
            no forecasts for this slate yet — run the cluster and every game it can price gets one
          </div>
        )}
        {visible.map((f) => {
          const stake = stakeOn(card, f.eventId);
          const gap = f.pMarket == null ? null : f.pModel - f.pMarket;
          const against = f.pMarket != null && f.pMarket < 0.5; // the market favours the other side
          return (
            <div key={f.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 border-t border-white/6 px-3 py-2.5 first:border-t-0 sm:px-4">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-[10px] text-[#5f7089]">
                    {new Date(f.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </span>
                  <span className="truncate font-mono text-[12px] font-bold text-[#d7e3f0]">{f.matchup}</span>
                  <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#5f7089]">{f.sport}</span>
                </div>
                <div className="font-mono text-[11px] text-[#8fa3bd]">
                  we favour <b className="text-[#d7e3f0]">{f.pick}</b>{" "}
                  <b className={cx(f.pModel >= 0.62 ? "text-[#37ff8b]" : f.pModel >= 0.55 ? "text-[#39d5ff]" : "text-[#8fa3bd]")}>{pct(f.pModel)}</b>
                  {f.pMarket != null ? (
                    <>
                      {" "}· market {pct(f.pMarket)}{" "}
                      <span className={cx(gap != null && gap >= 0.02 ? "text-[#37ff8b]" : "text-[#5f7089]")}>({pts(gap ?? 0)})</span>
                    </>
                  ) : (
                    <> · no posted line to compare</>
                  )}
                </div>
                {f.note && <div className="font-mono text-[10px] text-[#5f7089]">{f.note}</div>}
              </div>
              <div className="flex flex-col items-end gap-1">
                <Chip tone={stake.tone}>{stake.label}</Chip>
                {against && <Chip tone="amber">against the market</Chip>}
                {f.outcome === "win" && <Chip tone="green">right</Chip>}
                {f.outcome === "loss" && <Chip tone="red">wrong</Chip>}
              </div>
            </div>
          );
        })}
        {rows.length > SHOWN && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full border-t border-white/6 px-3 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#39d5ff] transition-colors hover:bg-white/[0.03]"
          >
            {expanded ? "show fewer" : `show all ${rows.length}`}
          </button>
        )}
      </Panel>
    </section>
  );
}
