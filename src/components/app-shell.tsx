"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Crosshair, Hexagon, Layers, Users, ScrollText, Zap, Radio, Cpu,
} from "lucide-react";
import type { AgentC, RunC, SlateResp } from "./types";
import { cx } from "./ui";
import WarRoom from "./war-room";
import AgentsView from "./agents-view";
import RunsView from "./runs-view";

const ALL_SPORTS = [
  { id: "nba", label: "NBA" },
  { id: "nfl", label: "NFL" },
  { id: "ncaaf", label: "NCAAF" },
  { id: "ncaab", label: "NCAAB" },
  { id: "mlb", label: "MLB" },
  { id: "nhl", label: "NHL" },
];

function etToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export default function AppShell() {
  const [tab, setTab] = useState<"war" | "agents" | "ledger">("war");
  const [date, setDate] = useState(etToday());
  const [sports, setSports] = useState<string[]>(["nba"]);
  const [slate, setSlate] = useState<SlateResp | null>(null);
  const [slateLoading, setSlateLoading] = useState(false);
  const [slateError, setSlateError] = useState<string | null>(null);
  const [agentsData, setAgentsData] = useState<AgentC[]>([]);
  const [runsData, setRunsData] = useState<RunC[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [activeRun, setActiveRun] = useState<RunC | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [clock, setClock] = useState("");
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

  // live ET clock
  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString("en-US", {
          timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
        }),
      );
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 5200);
  }, []);

  const loadSlate = useCallback(async () => {
    setSlateLoading(true);
    setSlateError(null);
    try {
      const res = await fetch(`/api/slate?date=${date}&sports=${sports.join(",")}`);
      const data = await res.json();
      if (data.error) {
        setSlateError(`${data.error}${data.hint ? ` — ${data.hint}` : ""}`);
        setSlate(null);
      } else {
        setSlate(data);
      }
    } catch {
      setSlateError(
        "The slate request timed out or was blocked. On free hosting tiers try one sport at a time, then retry.",
      );
      setSlate(null);
    } finally {
      setSlateLoading(false);
    }
  }, [date, sports]);

  const loadRuns = useCallback(async () => {
    const res = await fetch("/api/runs");
    const data = await res.json();
    setRunsData(data.runs ?? []);
  }, []);

  const loadAgents = useCallback(async () => {
    const res = await fetch("/api/agents");
    const data = await res.json();
    setAgentsData(data.agents ?? []);
  }, []);

  useEffect(() => { void loadSlate(); }, [loadSlate]);
  useEffect(() => { void loadRuns(); void loadAgents(); }, [loadRuns, loadAgents]);

  // poll the active run while the cluster is thinking
  useEffect(() => {
    if (activeId == null) return;
    let dead = false;
    const poll = async () => {
      const res = await fetch(`/api/runs/${activeId}`);
      const data = await res.json();
      if (dead || !data.run) return;
      setActiveRun(data.run);
      if (data.run.status === "running") setTimeout(poll, 1300);
      else { void loadRuns(); void loadAgents(); }
    };
    void poll();
    return () => { dead = true; };
  }, [activeId, loadRuns, loadAgents]);

  const launch = useCallback(async () => {
    setLaunching(true);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date, sports }),
      });
      const data = await res.json();
      if (data.id) {
        setActiveId(data.id);
        setActiveRun(null);
      } else flash(data.error ?? "launch failed");
    } catch {
      flash("launch request dropped — retry");
    } finally {
      setLaunching(false);
    }
  }, [date, sports, flash]);

  const grade = useCallback(async () => {
    const res = await fetch("/api/grade", { method: "POST" });
    const data = await res.json();
    if (data.error) flash(`grading fault: ${data.error}`);
    else if (data.graded === 0) flash("no settled games yet — check back after final whistles");
    else flash(`graded ${data.graded} predictions — ${data.wins}W · ${data.losses}L · ${data.pushes}P. agent ratings updated.`);
    void loadRuns(); void loadAgents();
  }, [flash, loadRuns, loadAgents]);

  const toggleSport = (id: string) => {
    setSports((cur) => {
      if (cur.includes(id)) return cur.length === 1 ? cur : cur.filter((s) => s !== id);
      return [...cur, id];
    });
  };

  const running = activeRun?.status === "running";
  const llmOnline = (slate?.providers.length ?? 0) > 0;

  const cardForDate = useMemo(() => {
    if (activeRun && activeRun.status !== "running") return activeRun;
    return runsData.find((r) => r.slateDate === date) ?? null;
  }, [activeRun, runsData, date]);

  return (
    <div className="relative min-h-screen">
      <div className="grid-bg pointer-events-none fixed inset-0" />

      {/* ---------------- header ---------------- */}
      <header className="sticky top-0 z-50 border-b border-[#37ff8b]/12 bg-[#04070d]/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Hexagon className="h-9 w-9 text-[#37ff8b]" strokeWidth={1.4} />
              <Crosshair className="absolute inset-0 m-auto h-4 w-4 text-[#37ff8b] blink" />
            </div>
            <div>
              <div className="font-display text-[22px] font-bold leading-none tracking-tight title-stroke">
                NEON<span className="text-[#37ff8b]">SLIP</span>
              </div>
              <div className="font-mono text-[9px] uppercase tracking-[0.32em] text-[#5f7089]">
                agent cluster // betting intel
              </div>
            </div>
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <span className={cx("clip-tag inline-flex items-center gap-1.5 border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em]",
              llmOnline ? "border-[#37ff8b]/35 bg-[#37ff8b]/10 text-[#37ff8b]" : "border-[#39d5ff]/30 bg-[#39d5ff]/10 text-[#39d5ff]")}>
              <Zap className="h-3 w-3" />
              {llmOnline ? `llm swarm · ${slate!.providers.length} provider${slate!.providers.length > 1 ? "s" : ""}` : "quant core · zero-key mode"}
            </span>
            {slate?.providers.map((p) => (
              <span key={p} className="clip-tag hidden border border-white/10 bg-white/5 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-[#8fa3bd] lg:inline-flex">
                <Cpu className="mr-1 h-3 w-3" />{p}
              </span>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.14em] text-[#5f7089]">
            <span className="hidden sm:inline-flex items-center gap-1.5">
              <Radio className="h-3.5 w-3.5 text-[#ff3d81]" /> ET {clock}
            </span>
            <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-[#37ff8b]" />
          </div>
        </div>

        {/* ---------------- tabs ---------------- */}
        <div className="mx-auto flex max-w-[1440px] items-center gap-1 px-4 sm:px-6">
          {([
            { id: "war", label: "War Room", icon: Layers, count: slate ? slate.counts.pre : null },
            { id: "agents", label: "Agent Roster", icon: Users, count: agentsData.length || null },
            { id: "ledger", label: "Prediction Ledger", icon: ScrollText, count: runsData.filter((r) => r.status === "completed").length || null },
          ] as const).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cx(
                "clip-tag group relative flex items-center gap-2 border-b-2 px-4 py-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.18em] transition-all",
                tab === t.id
                  ? "border-[#37ff8b] bg-[#37ff8b]/8 text-[#37ff8b]"
                  : "border-transparent text-[#5f7089] hover:bg-white/4 hover:text-[#d7e3f0]",
              )}
            >
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
              {t.count != null && (
                <span className={cx("clip-tag border px-1.5 py-px text-[9px]",
                  tab === t.id ? "border-[#37ff8b]/40 text-[#37ff8b]" : "border-white/15 text-[#5f7089]")}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      {/* ---------------- slate ticker ---------------- */}
      {slate && slate.games.length > 0 && (
        <div className="relative z-10 overflow-hidden border-b border-white/6 bg-[#05080f]/80">
          <div className="marquee-track flex w-max gap-10 px-6 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#5f7089]">
            {[0, 1].map((rep) => (
              <div key={rep} className="flex gap-10">
                {slate.games.map((g) => (
                  <span key={`${rep}-${g.eventId}`} className="flex items-center gap-2 whitespace-nowrap">
                    <span className="text-[#39d5ff]">{g.sportLabel}</span>
                    <span className="text-[#d7e3f0]">{g.matchup}</span>
                    {g.status === "pre" && g.odds?.details && <span className="text-[#37ff8b]">{g.odds.details}</span>}
                    {g.status === "pre" && g.odds?.overUnder != null && <span className="text-[#9d7bff]">o/u {g.odds.overUnder}</span>}
                    {g.status === "in" && <span className="text-[#ff3d81] blink">● live — excluded</span>}
                    {g.status === "post" && <span className="text-[#ffb020]">final — excluded</span>}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- toast ---------------- */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[70] -translate-x-1/2">
          <div className="panel panel-glow clip-tag px-5 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-[#37ff8b] rise">
            {toast}
          </div>
        </div>
      )}

      {/* ---------------- body ---------------- */}
      <main className="relative z-10 mx-auto max-w-[1440px] px-4 pb-24 pt-6 sm:px-6">
        {tab === "war" && (
          <WarRoom
            date={date}
            setDate={setDate}
            sports={sports}
            allSports={ALL_SPORTS}
            toggleSport={toggleSport}
            slate={slate}
            slateLoading={slateLoading}
            slateError={slateError}
            reloadSlate={loadSlate}
            launch={launch}
            running={!!running}
            launching={launching}
            activeRun={activeRun}
            card={cardForDate}
          />
        )}
        {tab === "agents" && <AgentsView agents={agentsData} reload={loadAgents} />}
        {tab === "ledger" && <RunsView runs={runsData} grade={grade} />}
      </main>

      <footer className="relative z-10 border-t border-white/6 py-6 text-center font-mono text-[9px] uppercase tracking-[0.24em] text-[#3d4c63]">
        neonslip // hierarchical agent cluster · data: espn public feeds · brains: gemini · grok · openrouter · ollama · self-hosted quant core
        <br />for entertainment &amp; research. no odds are guaranteed. bet nothing you can&apos;t torch.
      </footer>
    </div>
  );
}
