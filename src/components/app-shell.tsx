"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Crosshair, Hexagon, Layers, Users, ScrollText, Zap, Radio, Cpu, KeyRound, Wallet,
} from "lucide-react";
import type { AgentC, BetC, BetResult, BetSummaryC, Discipline, RunC, SlateResp } from "./types";
import { cx } from "./ui";
import KeysModal from "./keys-modal";
import {
  loadLlmMode,
  loadVault,
  saveLlmMode,
  ownerFetch,
  vaultActive,
  vaultFetch,
  EMPTY_VAULT,
  type KeyVault,
  type LlmMode,
} from "./keys";
import WarRoom from "./war-room";
import AgentsView from "./agents-view";
import RunsView from "./runs-view";
import { MyBetsView } from "./my-bets-view";
import type { BetSavePayload } from "./bet-control";
import { RELEASE_LABEL } from "@/lib/release";

const ALL_SPORTS = [
  { id: "nba", label: "NBA" },
  { id: "nfl", label: "NFL" },
  { id: "ncaaf", label: "NCAAF" },
  { id: "ncaab", label: "NCAAB" },
  { id: "mlb", label: "MLB" },
  { id: "nhl", label: "NHL" },
  { id: "ufc", label: "UFC" },
  { id: "dwcs", label: "DWCS" },
  { id: "pfl", label: "PFL" },
];

const DISCIPLINE_KEY = "neonslip.discipline.v1";

function etToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export default function AppShell() {
  const [tab, setTab] = useState<"war" | "agents" | "ledger" | "bets">("war");
  const [date, setDate] = useState(etToday());
  const [sports, setSports] = useState<string[]>(["nba"]);
  const [slate, setSlate] = useState<SlateResp | null>(null);
  const [slateLoading, setSlateLoading] = useState(false);
  const [slateError, setSlateError] = useState<string | null>(null);
  const [agentsData, setAgentsData] = useState<AgentC[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [runsData, setRunsData] = useState<RunC[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [activeRun, setActiveRun] = useState<RunC | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [clock, setClock] = useState("");
  const [vault, setVault] = useState<KeyVault>(EMPTY_VAULT);
  const [keysOpen, setKeysOpen] = useState(false);
  const [markets, setMarkets] = useState<string[]>([]);
  const [llmMode, setLlmMode] = useState<LlmMode>("off");
  const [excludedEvents, setExcludedEvents] = useState<string[]>([]);
  const [discipline, setDisciplineState] = useState<Discipline>("standard");
  const [bets, setBets] = useState<BetC[]>([]);
  const [betSummary, setBetSummary] = useState<BetSummaryC | null>(null);
  const [betsLoading, setBetsLoading] = useState(true);
  const [betsError, setBetsError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

  // hydrate the visitor's own key vault from localStorage
  useEffect(() => {
    setVault(loadVault());
    setLlmMode(loadLlmMode());
    try {
      const d = window.localStorage.getItem(DISCIPLINE_KEY);
      if (d === "strict" || d === "standard" || d === "loose") setDisciplineState(d);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const setDiscipline = useCallback((d: Discipline) => {
    setDisciplineState(d);
    try {
      window.localStorage.setItem(DISCIPLINE_KEY, d);
    } catch {
      /* storage unavailable */
    }
  }, []);

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
      const res = await vaultFetch(
        `/api/slate?date=${date}&sports=${sports.join(",")}`,
        {},
        vault,
        { llmMode },
      );
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
  }, [date, sports, vault, llmMode]);

  const loadRuns = useCallback(async () => {
    const res = await vaultFetch("/api/runs", {}, vault, { llmMode });
    const data = await res.json();
    setRunsData(data.runs ?? []);
  }, [vault, llmMode]);

  const loadAgents = useCallback(async () => {
    const res = await vaultFetch("/api/agents", {}, vault, { llmMode });
    const data = await res.json();
    setAgentsData(data.agents ?? []);
    setIsAdmin(!!data.isAdmin);
  }, [vault, llmMode]);

  // ---- personal bet tracker ----
  const loadBets = useCallback(async () => {
    try {
      const res = await ownerFetch("/api/bets");
      const data = await res.json();
      if (!res.ok) {
        setBetsError(data.error ?? "could not load your bets");
        return;
      }
      setBets(data.bets ?? []);
      setBetSummary(data.summary ?? null);
      setBetsError(null);
    } catch {
      setBetsError("could not reach the server to load your bets");
    } finally {
      setBetsLoading(false);
    }
  }, []);

  const saveBet = useCallback(
    async (p: BetSavePayload): Promise<string | null> => {
      try {
        const res = await ownerFetch("/api/bets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(p),
        });
        const data = await res.json();
        if (!res.ok) return data.error ?? "could not save the bet";
        await loadBets();
        flash("bet tracked — it will settle automatically when the result is graded");
        return null;
      } catch {
        return "network error — try again";
      }
    },
    [loadBets, flash],
  );

  const removeBet = useCallback(
    async (predictionId: number): Promise<void> => {
      try {
        await ownerFetch(`/api/bets?predictionId=${predictionId}`, { method: "DELETE" });
      } finally {
        await loadBets();
      }
    },
    [loadBets],
  );

  const setBetResult = useCallback(
    async (predictionId: number, result: Exclude<BetResult, "pending"> | null): Promise<string | null> => {
      try {
        const res = await ownerFetch("/api/bets", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ predictionId, result }),
        });
        const data = await res.json();
        if (!res.ok) return data.error ?? "could not update the bet";
        await loadBets();
        return null;
      } catch {
        return "network error — try again";
      }
    },
    [loadBets],
  );

  const betsByPred = useMemo(() => new Map(bets.map((b) => [b.predictionId, b])), [bets]);

  useEffect(() => { void loadSlate(); }, [loadSlate]);
  useEffect(() => { void loadRuns(); void loadAgents(); void loadBets(); }, [loadRuns, loadAgents, loadBets]);

  // poll the active run while the cluster is thinking
  useEffect(() => {
    if (activeId == null) return;
    let dead = false;
    const poll = async () => {
      const res = await vaultFetch(`/api/runs/${activeId}`, {}, vault, { llmMode });
      const data = await res.json();
      if (dead || !data.run) return;
      setActiveRun(data.run);
      if (data.run.status === "running") setTimeout(poll, 1300);
      else { void loadRuns(); void loadAgents(); }
    };
    void poll();
    return () => { dead = true; };
  }, [activeId, loadRuns, loadAgents, vault, llmMode]);

  const launch = useCallback(async () => {
    setLaunching(true);
    try {
      const res = await vaultFetch(
        "/api/runs",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            date,
            sports,
            markets,
            discipline,
            includeEvents:
              slate?.games
                .filter((g) => g.status === "pre" && !excludedEvents.includes(g.eventId))
                .map((g) => g.eventId) ?? [],
          }),
        },
        vault,
        { llmMode },
      );
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
  }, [date, sports, markets, discipline, flash, vault, llmMode, slate, excludedEvents]);

  const grade = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await vaultFetch("/api/grade", { method: "POST" }, vault, { llmMode });
      const data = await res.json();
      if (data.error) flash(`grading fault: ${data.error}`);
      else if (data.graded === 0 && !data.voided) flash("no settled games yet — check back after final whistles");
      else
        flash(
          `graded ${data.graded} predictions — ${data.wins}W · ${data.losses}L · ${data.pushes}P${data.voided ? ` · ${data.voided} voided` : ""}. agent ratings updated.`,
        );
      void loadRuns(); void loadAgents(); void loadBets();
    } catch {
      flash("grading request dropped — retry");
    } finally {
      setSyncing(false);
    }
  }, [flash, loadRuns, loadAgents, loadBets, vault, llmMode]);

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
    // Match both date AND the currently selected sports so switching from
    // NHL to DWCS doesn't keep showing the old NHL card.
    const sportsKey = [...sports].sort().join(",");
    return (
      runsData.find((r) => {
        if (r.slateDate !== date) return false;
        const rKey = [...(r.sports ?? [])].sort().join(",");
        return rKey === sportsKey;
      }) ?? null
    );
  }, [activeRun, runsData, date, sports]);

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
              <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.16em] text-[#37ff8b]/70">
                {RELEASE_LABEL}
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

          <div className="ml-auto flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.14em] text-[#5f7089]">
            <button
              onClick={() => setKeysOpen(true)}
              className={cx(
                "clip-tag flex items-center gap-1.5 border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] transition-all",
                vaultActive(vault)
                  ? "border-[#37ff8b]/40 bg-[#37ff8b]/10 text-[#37ff8b] shadow-[0_0_14px_-4px_rgba(55,255,139,0.5)]"
                  : "border-white/15 bg-white/[0.03] text-[#5f7089] hover:border-[#39d5ff]/40 hover:text-[#39d5ff]",
              )}
              title="Add your own free AI keys (optional)"
            >
              <KeyRound className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{vaultActive(vault) ? "keys stored" : "add ai keys"}</span>
            </button>
            <span className="hidden sm:inline-flex items-center gap-1.5">
              <Radio className="h-3.5 w-3.5 text-[#ff3d81]" /> ET {clock}
            </span>
            <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-[#37ff8b]" />
          </div>
        </div>

        {/* ---------------- tabs ---------------- */}
        {/* Scrolls sideways instead of forcing the whole page wider than the screen:
            on a phone the old row overflowed, so the browser zoomed the page out. */}
        <div className="mx-auto flex max-w-[1440px] items-center gap-1 overflow-x-auto px-2 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden">
          {([
            { id: "war", label: "War Room", short: "War Room", icon: Layers, count: slate ? slate.counts.pre : null },
            { id: "agents", label: "Agent Roster", short: "Roster", icon: Users, count: agentsData.length || null },
            { id: "ledger", label: "Prediction Ledger", short: "Ledger", icon: ScrollText, count: runsData.filter((r) => r.status === "completed").length || null },
            { id: "bets", label: "My Bets", short: "My Bets", icon: Wallet, count: bets.length || null },
          ] as const).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cx(
                "clip-tag group relative flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition-all sm:gap-2 sm:px-4 sm:tracking-[0.18em]",
                tab === t.id
                  ? "border-[#37ff8b] bg-[#37ff8b]/8 text-[#37ff8b]"
                  : "border-transparent text-[#5f7089] hover:bg-white/4 hover:text-[#d7e3f0]",
              )}
            >
              <t.icon className="hidden h-3.5 w-3.5 sm:block" />
              <span className="sm:hidden">{t.short}</span>
              <span className="hidden sm:inline">{t.label}</span>
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

      {keysOpen && (
        <KeysModal
          vault={vault}
          setVault={setVault}
          onClose={() => setKeysOpen(false)}
          onSaved={() => {
            flash("key vault saved to this device — agents rerouted to your models");
            void loadAgents();
            void loadSlate();
          }}
        />
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
            markets={markets}
            setMarkets={setMarkets}
            llmMode={llmMode}
            setLlmMode={(mode: LlmMode) => {
              setLlmMode(mode);
              saveLlmMode(mode);
            }}
            excludedEvents={excludedEvents}
            setExcludedEvents={setExcludedEvents}
            slate={slate}
            slateLoading={slateLoading}
            slateError={slateError}
            reloadSlate={loadSlate}
            launch={launch}
            running={!!running}
            launching={launching}
            activeRun={activeRun}
            card={cardForDate}
            discipline={discipline}
            setDiscipline={setDiscipline}
            betsByPred={betsByPred}
            onSaveBet={saveBet}
            onRemoveBet={removeBet}
          />
        )}
        {tab === "agents" && <AgentsView agents={agentsData} reload={loadAgents} isAdmin={isAdmin} />}
        {tab === "ledger" && (
          <RunsView runs={runsData} grade={grade} syncing={syncing} betsByPred={betsByPred} onSaveBet={saveBet} onRemoveBet={removeBet} />
        )}
        {tab === "bets" && (
          <MyBetsView
            bets={bets}
            summary={betSummary}
            loading={betsLoading}
            error={betsError}
            syncing={syncing}
            onSync={grade}
            onSave={saveBet}
            onRemove={removeBet}
            onResult={setBetResult}
          />
        )}
      </main>

      <footer className="relative z-10 border-t border-white/6 py-6 text-center font-mono text-[9px] uppercase tracking-[0.24em] text-[#3d4c63]">
        neonslip // hierarchical agent cluster · data: espn public feeds · brains: gemini · grok · openrouter · ollama · self-hosted quant core
        <br />for entertainment &amp; research. no odds are guaranteed. bet nothing you can&apos;t torch.
      </footer>
    </div>
  );
}
