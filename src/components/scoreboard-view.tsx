"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Target } from "lucide-react";
import { MIN_PAIRED, type Score, type Verdict } from "@/lib/forecast";
import type { ScoreboardC } from "./types";
import { Chip, Panel, cx } from "./ui";

const pc = (x: number | null, d = 1): string => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const br = (x: number | null): string => (x == null ? "—" : x.toFixed(3));
const signed = (x: number | null): string => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(3)}`);

const VERDICT: Record<Verdict, { tone: string; title: string }> = {
  "too early": { tone: "slate", title: "Too early to tell" },
  "no market to compare": { tone: "slate", title: "No market to compare" },
  "beats the market": { tone: "green", title: "Beats the market" },
  "trails the market": { tone: "red", title: "Trails the market" },
  "no clear difference": { tone: "amber", title: "No clear difference yet" },
};

/** The one-paragraph, plain-English reading of a score — never claims more than the numbers support. */
function reading(s: Score): string {
  const gap = s.edge == null ? "" : `${Math.abs(s.edge).toFixed(3)} ${s.edge >= 0 ? "better" : "worse"} than the market`;
  switch (s.verdict) {
    case "too early":
      return s.n === 0
        ? "Nothing has been graded yet."
        : `Only ${s.nPaired} graded game${s.nPaired === 1 ? "" : "s"} had a market price to compare with; we need at least ${MIN_PAIRED} before saying anything. A 55% pick still loses 45% of the time, so a handful of games cannot separate skill from luck.`;
    case "no market to compare":
      return "These games had no posted moneyline, so there is no market probability to compare our numbers with.";
    case "beats the market":
      return `Over ${s.nPaired} games with a market price, our probabilities scored ${gap}, by more than luck explains (95% level). That is the evidence of real skill — keep tracking it.`;
    case "trails the market":
      return `Over ${s.nPaired} games with a market price, our probabilities scored ${gap}, by more than luck explains. In this sample the market is the better forecaster and the engine's adjustments are not adding value.`;
    default:
      return `Over ${s.nPaired} games with a market price our probabilities scored ${gap}, but the gap is within what luck alone produces. Keep collecting games.`;
  }
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="panel scanlines min-w-[9.5rem] flex-1 p-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#5f7089]">{label}</div>
      <div className={cx("font-display text-2xl font-bold", tone ?? "text-[#d7e3f0]")}>{value}</div>
      {sub && <div className="mt-0.5 font-mono text-[10px] leading-snug text-[#5f7089]">{sub}</div>}
    </div>
  );
}

export default function ScoreboardView() {
  const [reload, setReload] = useState(0);
  // null = nothing loaded yet. On a refresh the old numbers stay on screen until the new ones arrive.
  const [state, setState] = useState<{ data: ScoreboardC | null; error: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/scoreboard")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
        return j as ScoreboardC;
      })
      .then((data) => {
        if (alive) setState({ data, error: null });
      })
      .catch((e: unknown) => {
        if (alive) setState((prev) => ({ data: prev?.data ?? null, error: e instanceof Error ? e.message : "could not load the scoreboard" }));
      });
    return () => {
      alive = false;
    };
  }, [reload]);

  const sb = state?.data ?? null;
  const o = sb?.overall;
  const v = o ? VERDICT[o.verdict] : null;
  const marginOfError = o?.edgeSe != null ? 1.96 * o.edgeSe : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Target className="h-6 w-6 text-[#39d5ff]" />
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight title-stroke">
          Scoreboard <span className="text-[#39d5ff]">{"//"} how good are the forecasts?</span>
        </h2>
        {sb && <Chip tone="cyan">{sb.overall.n} graded</Chip>}
        {sb && sb.pending > 0 && <Chip tone="slate">{sb.pending} waiting on their game</Chip>}
        <button
          onClick={() => setReload((n) => n + 1)}
          className="clip-tag ml-auto flex items-center gap-1.5 border border-white/10 bg-white/[0.03] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#8fa3bd] transition-all hover:border-white/25"
        >
          <RefreshCw className="h-3 w-3" /> refresh
        </button>
      </div>

      <p className="font-mono text-[10px] leading-relaxed tracking-[0.04em] text-[#5f7089]">
        Every game gets a forecast — our win probability next to the market&apos;s — and every one is graded once the game ends, bet or no bet.
        Winning a lot is not the same as being good: backing the favourite wins often too. The real question is whether our probabilities beat the{" "}
        <b className="text-[#8fa3bd]">market&apos;s own</b> on the same games, because the market&apos;s price is the best free forecast there is.
        Scores use <b className="text-[#8fa3bd]">Brier</b>: 0 is perfect, 0.250 is a coin flip every time, lower is better.
      </p>

      {!state && <Panel className="p-8 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-[#5f7089]">loading the scoreboard…</Panel>}
      {state?.error && <Panel className="p-5 font-mono text-[11px] text-[#ff4757]">couldn&apos;t load the scoreboard — {state.error}</Panel>}

      {sb && o && v && o.n === 0 && (
        <Panel className="space-y-2 p-8 text-center font-mono text-[11px] leading-relaxed text-[#5f7089]">
          <div className="uppercase tracking-[0.2em]">nothing graded yet</div>
          <div>
            Run the cluster in the War Room — every game it can price gets a forecast. After the games finish, tap <b className="text-[#8fa3bd]">sync &amp; grade</b>{" "}
            (Ledger or My Bets) and the results land here.{sb.pending > 0 ? ` ${sb.pending} forecast${sb.pending === 1 ? " is" : "s are"} waiting on their games right now.` : ""}
          </div>
        </Panel>
      )}

      {sb && o && v && o.n > 0 && (
        <>
          <Panel className="space-y-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-3">
              <Chip tone={v.tone} className="text-[11px]">
                {v.title}
              </Chip>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#5f7089]">
                {o.n} graded{sb.since ? ` · since ${sb.since}` : ""} · {o.nPaired} with a market price
              </span>
            </div>
            <p className="font-mono text-[12px] leading-relaxed text-[#b9c8dc]">{reading(o)}</p>
          </Panel>

          <div className="flex flex-wrap gap-2">
            <Stat
              label="Winners picked"
              value={pc(o.hitRate)}
              sub={o.marketHitRatePaired != null ? `backing the market's favourite on the same games: ${pc(o.marketHitRatePaired)}` : "no market to compare"}
            />
            <Stat label="Our Brier" value={br(o.brier)} sub="coin flip = 0.250 · lower is better" />
            <Stat
              label="Us vs market (Brier)"
              value={signed(o.edge)}
              tone={o.verdict === "beats the market" ? "text-[#37ff8b]" : o.verdict === "trails the market" ? "text-[#ff4757]" : undefined}
              sub={
                o.nPaired
                  ? `ours ${br(o.brierModel)} · market ${br(o.brierMarket)} · ± ${marginOfError == null ? "—" : marginOfError.toFixed(3)} margin of error (+ = we're better)`
                  : "no games with a market price yet"
              }
            />
            <Stat
              label="Disagreed with the market"
              value={`${o.disagreed}`}
              sub={o.disagreed ? `we backed the other side and were right ${o.disagreedRight} of ${o.disagreed} (${pc(o.disagreedRight / o.disagreed, 0)})` : "we always agreed on the favourite"}
            />
          </div>

          <Panel className="overflow-x-auto">
            <div className="min-w-[34rem]">
              <div className="grid grid-cols-[1.2fr_0.6fr_0.8fr_0.8fr_1fr_1.4fr] gap-2 border-b border-white/8 px-4 py-2 font-mono text-[9px] uppercase tracking-[0.18em] text-[#5f7089]">
                <span>sport</span>
                <span>games</span>
                <span>winners</span>
                <span>our Brier</span>
                <span>vs market</span>
                <span>verdict</span>
              </div>
              {sb.bySport.map(({ sport, score: s }) => (
                <div key={sport} className="grid grid-cols-[1.2fr_0.6fr_0.8fr_0.8fr_1fr_1.4fr] items-center gap-2 border-t border-white/6 px-4 py-2 font-mono text-[11px] text-[#b9c8dc]">
                  <span className="font-bold uppercase text-[#d7e3f0]">{sport}</span>
                  <span>{s.n}</span>
                  <span>{pc(s.hitRate, 0)}</span>
                  <span>{br(s.brier)}</span>
                  <span>{s.nPaired ? signed(s.edge) : "—"}</span>
                  <span>
                    <Chip tone={VERDICT[s.verdict].tone}>{VERDICT[s.verdict].title}</Chip>
                  </span>
                </div>
              ))}
            </div>
          </Panel>

          <div className="space-y-2">
            <h3 className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#8fa3bd]">Do our percentages mean what they say?</h3>
            <p className="font-mono text-[10px] leading-relaxed text-[#5f7089]">
              Of the games where we said about 60%, about 60% should have been won. The bar is how often the pick actually won; the tick is what we said. Bands
              with under 10 games are mostly noise.
            </p>
            <Panel className="divide-y divide-white/6">
              {sb.calibration.map((b) => (
                <div key={b.lo} className={cx("grid grid-cols-[4.5rem_1fr_6.5rem] items-center gap-3 px-4 py-2 font-mono text-[11px]", b.n < 10 && "opacity-50")}>
                  <span className="text-[#8fa3bd]">
                    {Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}%
                  </span>
                  <div className="relative h-2 rounded-sm bg-white/[0.06]" title={`we said ${pc(b.predicted, 0)}, the pick won ${pc(b.actual, 0)}`}>
                    <div className="absolute inset-y-0 left-0 rounded-sm bg-[#39d5ff]/70" style={{ width: `${b.actual * 100}%` }} />
                    <div className="absolute -inset-y-1 w-[2px] bg-[#ffb020]" style={{ left: `${b.predicted * 100}%` }} />
                  </div>
                  <span className="text-right text-[#b9c8dc]">
                    {pc(b.actual, 0)} <span className="text-[#5f7089]">of {b.n}</span>
                  </span>
                </div>
              ))}
            </Panel>
          </div>

          {sb.recent.length > 0 && (
            <div className="space-y-2">
              <h3 className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#8fa3bd]">Latest results</h3>
              <Panel className="divide-y divide-white/6">
                {sb.recent.map((r, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 font-mono text-[11px]">
                      <div className="truncate font-bold text-[#d7e3f0]">{r.matchup}</div>
                      <div className="text-[#8fa3bd]">
                        we picked <b className="text-[#d7e3f0]">{r.pick}</b> {pc(r.pModel, 0)}
                        {r.pMarket != null ? ` · market ${pc(r.pMarket, 0)}` : ""} · <span className="text-[#5f7089]">{r.slateDate}</span>
                      </div>
                      {r.finalScore && <div className="truncate text-[10px] text-[#5f7089]">{r.finalScore}</div>}
                    </div>
                    <Chip tone={r.outcome === "win" ? "green" : "red"}>{r.outcome === "win" ? "right" : "wrong"}</Chip>
                  </div>
                ))}
              </Panel>
            </div>
          )}
        </>
      )}
    </div>
  );
}
