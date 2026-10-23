import { db } from "@/db";
import {
  agents,
  predictions,
  runs,
  type CouncilDecision,
  type GradeSpec,
  type MmaGrade,
  type TraceEntry,
} from "@/db/schema";
import { and, asc, eq, lt } from "drizzle-orm";
import { ensureAgentsSeeded, settleAgentRatings, type GradedForRating } from "./agents";
import { fmtOdds, pct, type Candidate } from "./candidate";
import { DISCIPLINES, disciplineOf, type Discipline } from "./discipline";
import {
  getFinals,
  getSlateDetailed,
  lookupPlayerStat,
  mapLimit,
  type FinalScore,
  type GameInfo,
} from "./espn";
import {
  buildEnhancedCombatModel,
  fetchBoutMoneylines,
  fetchBoutProfiles,
  fetchFightStatLine,
} from "./fighter-stats";
import { describeFight, settleMma, settleTeam, type FightStatsLike, type Outcome } from "./grading";
import { loadHealth, NEUTRAL, type BucketHealth, type HealthReport } from "./health";
import { targetFor, type KeyBag } from "./llm";
import { buildFilter, COMBAT_CATEGORIES, type MarketFilter } from "./markets";
import { evaluateBout } from "./mma-picks";
import { HOUSE } from "./owner";
import { applyReviews, collectReviews, type ReviewJob, type SourcedReview } from "./review";
import { ensureSchema } from "./schema";
import { MAX_UNITS_BOOK, MAX_UNITS_MODEL, nearMisses, selectCard, sizeOf } from "./selection";
import { evaluateTeamGame, type GameIntel } from "./team-model";

export const revalidate = 0;

/** Marks rows written by this engine. Rows from before the rewrite carry 4. */
export const ENGINE_VERSION = 5;

// ---------------------------------------------------------------------------
// slate cache (hot path shared by UI + pipeline)
// ---------------------------------------------------------------------------

const slateCache = new Map<string, { at: number; games: GameInfo[]; degraded: string[] }>();
const SLATE_TTL = 75_000;

export async function cachedSlate(
  date: string,
  sports: string[],
  opts: { budgetMs?: number; maxInjuryLookups?: number } = {},
): Promise<{ games: GameInfo[]; degraded: string[] }> {
  const key = `${date}|${[...sports].sort().join(",")}`;
  const hit = slateCache.get(key);
  if (hit && Date.now() - hit.at < SLATE_TTL) {
    return { games: hit.games, degraded: hit.degraded };
  }
  const { games, degraded } = await getSlateDetailed(date, sports, {
    budgetMs: opts.budgetMs ?? 12_000,
    maxInjuryLookups: opts.maxInjuryLookups ?? 30,
  });
  const note = await enrichCombat(games);
  if (note) degraded.push(note);
  slateCache.set(key, { at: Date.now(), games, degraded });
  return { games, degraded };
}

/**
 * Upcoming bouts get real ESPN fighter statistics (parallel, budget-capped),
 * rebuild their joint model from them, and — when ESPN happens to publish a
 * moneyline — a real price. Returns a short note when stats were unavailable.
 */
export async function enrichCombat(games: GameInfo[], budgetMs = 8_000): Promise<string | null> {
  const pre = games.filter((g) => g.status === "pre" && g.combat?.eventId && g.combat.competitionId);
  if (!pre.length) return null;
  const deadline = Date.now() + budgetMs;
  let withStats = 0;
  let attempted = 0;
  await mapLimit(pre.slice(0, 16), 6, async (g) => {
    const c = g.combat;
    if (!c || Date.now() > deadline) return;
    attempted++;
    try {
      const league = c.league as "ufc" | "pfl";
      const { away: ap, home: hp, ids } = await fetchBoutProfiles(c.eventId, c.competitionId, league);
      const enhanced = buildEnhancedCombatModel(
        g.away.record,
        g.home.record,
        c.weightClass,
        c.scheduledRounds,
        ap,
        hp,
        c.promotion,
      );
      c.model = { ...enhanced };
      c.dist = enhanced.dist;
      if (ids.away && ids.home) c.fighterIds = { away: ids.away, home: ids.home };
      if (enhanced.summary) g.context.notes = [enhanced.summary];
      if (enhanced.statsUsed) withStats++;
      if (Date.now() < deadline && !g.odds) {
        const ml = await fetchBoutMoneylines(league, c.eventId, c.competitionId, c.fighterIds.away, c.fighterIds.home);
        if (ml) {
          g.odds = {
            provider: "ESPN",
            details: `ML ${g.away.abbr} ${fmtOdds(ml.away)} / ${g.home.abbr} ${fmtOdds(ml.home)}`,
            homeSpread: null,
            homeSpreadOdds: null,
            awaySpreadOdds: null,
            homeML: ml.home,
            awayML: ml.away,
            overUnder: null,
            overOdds: null,
            underOdds: null,
            homeTeamTotal: null,
            awayTeamTotal: null,
            teamTotalsDerived: false,
          };
          c.priceSource = "espn";
        }
      }
    } catch {
      /* the record-based model from the scoreboard stays in place */
    }
  });
  if (attempted && withStats === 0) {
    return `ESPN fighter stats were unavailable for all ${attempted} bouts — MMA picks fall back to records only (stricter bar, no strikes/takedown/method props)`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// bookkeeping
// ---------------------------------------------------------------------------

async function trace(runId: number, entry: Omit<TraceEntry, "at">): Promise<void> {
  const [row] = await db.select({ trace: runs.trace }).from(runs).where(eq(runs.id, runId));
  const next = [...(row?.trace ?? []), { ...entry, at: new Date().toISOString() }];
  await db.update(runs).set({ trace: next }).where(eq(runs.id, runId));
}

const COMBAT_SPORTS = new Set(["ufc", "dwcs", "pfl"]);
const expertKey = (sport: string): string => (COMBAT_SPORTS.has(sport) ? "expert-mma" : `expert-${sport}`);
const maxUnitsFor = (c: Candidate): number => (c.priceSource === "model" ? MAX_UNITS_MODEL : MAX_UNITS_BOOK);

/**
 * Credit only the agents that actually backed a pick, so each builds its own
 * record. (The old code stamped five council agents on every pick, which made
 * their ratings move in lockstep and say nothing.)
 */
export function stampAgents(c: Candidate, health: BucketHealth): string[] {
  const out = new Set<string>(c.signals);
  out.add("COMMISSIONER"); // the card's record is the commissioner's record
  if (c.agree >= 2) out.add("STRATEGA"); // convergence of independent signals
  if (c.odds > 0 || c.modelProb < 0.5) out.add("CONTRARIAN"); // plus-money / underdog angles
  const capped = (c.finalUnits ?? 0) >= maxUnitsFor(c) - 1e-9;
  if (capped || health.stakeMult < 1) out.add("RISK"); // RISK actively limited this stake
  if (health.n >= 20) out.add("HISTORIAN"); // a measured track record informed the decision
  return [...out];
}

// ---------------------------------------------------------------------------
// the pipeline
// ---------------------------------------------------------------------------

function summariseIntel(intels: { g: GameInfo; intel: GameIntel }[]): {
  usable: number;
  withProjection: number;
  restSpots: number;
  injurySpots: number;
  unchecked: number;
  rejected: Map<string, number>;
} {
  const rejected = new Map<string, number>();
  let usable = 0;
  let withProjection = 0;
  let restSpots = 0;
  let injurySpots = 0;
  let unchecked = 0;
  for (const { g, intel } of intels) {
    if (intel.usable) {
      usable++;
      if (g.context.predictor) withProjection++;
      if (Math.abs(intel.restAdj) > 0) restSpots++;
      if (Math.abs(intel.injAdj) > 0) injurySpots++;
    } else if (intel.reason) {
      if (/injury report/.test(intel.reason)) unchecked++;
      const k = intel.reason.replace(/\s*\(.*\)$/, "");
      rejected.set(k, (rejected.get(k) ?? 0) + 1);
    }
  }
  return { usable, withProjection, restSpots, injurySpots, unchecked, rejected };
}

export async function runPipeline(
  runId: number,
  keys: KeyBag = {},
  ownerId: string = HOUSE,
  llmEnabled = true,
): Promise<void> {
  const t0 = Date.now();
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return;
  const discipline: Discipline = disciplineOf(run.discipline);
  const cfg = DISCIPLINES[discipline];

  // Always use the HOUSE roster for the shared record and global playbooks.
  await ensureAgentsSeeded(HOUSE);
  const roster = await db.select().from(agents).where(eq(agents.ownerId, HOUSE));
  const agentRow = (key: string) => roster.find((a) => a.codename === key || a.agentKey === key);
  const llmReady = !!targetFor("scout-quant", keys, llmEnabled);
  const mode = llmReady ? "llm" : "heuristic";

  try {
    await trace(runId, {
      layer: "system",
      agent: "KERNEL",
      message: `Cluster booting — ${mode === "llm" ? "LLM reviewers online on top of the quantitative core" : "self-hosted quantitative core (no API keys detected)"}. Discipline: ${cfg.label} (${cfg.hint}). Pulling slate for ${run.slateDate}…`,
      mood: "info",
    });

    const { games, degraded } = await cachedSlate(run.slateDate, run.sports, {
      budgetMs: 16_000,
      maxInjuryLookups: 26,
    });
    if (degraded.length) {
      await trace(runId, {
        layer: "system",
        agent: "KERNEL",
        message: `intel note — ${degraded.join("; ")}. Agents proceed on available data.`,
        mood: "warn",
      });
    }
    let pre = games.filter((g) => g.status === "pre");
    if ((run.includeEvents ?? []).length > 0) {
      const keep = new Set(run.includeEvents);
      const before = pre.length;
      pre = pre.filter((g) => keep.has(g.eventId));
      await trace(runId, {
        layer: "system",
        agent: "KERNEL",
        message: `operator filter engaged — ${pre.length}/${before} queued games explicitly selected for analysis.`,
        mood: "info",
      });
    }
    const skipped = games.length - pre.length;
    await trace(runId, {
      layer: "system",
      agent: "KERNEL",
      message: `Slate locked: ${games.length} games found — ${pre.length} queued for analysis${skipped > 0 ? `, ${skipped} skipped (already live or final)` : ""}.`,
      mood: "success",
    });
    await db
      .update(runs)
      .set({ gamesFound: games.length, gamesAnalyzed: pre.length, gamesSkipped: skipped, mode })
      .where(eq(runs.id, runId));

    if (!pre.length) {
      await trace(runId, { layer: "system", agent: "KERNEL", message: "No upcoming games on this slate. Standing down.", mood: "warn" });
      await finishRun(
        runId, ownerId, run.slateDate,
        { headline: "No active slate", memo: "Every game on the board was already live or final. Pick another date.", avoided: [], discipline, noPlay: true, exposure: 0, considered: 0, passed: 0 },
        [], new Map(),
      );
      return;
    }

    // ---------------- Layer 1: scouts ----------------
    const filter: MarketFilter = buildFilter(run.markets);
    let candId = 1;
    const nextId = () => candId++;
    const all: Candidate[] = [];
    const skippedNotes: string[] = [];
    const intels: { g: GameInfo; intel: GameIntel }[] = [];
    const bouts = pre.filter((g) => g.combat);
    for (const g of pre) {
      if (g.combat) {
        const r = evaluateBout(g, filter, nextId, discipline);
        all.push(...r.cands);
        skippedNotes.push(...r.skipped);
      } else {
        const r = evaluateTeamGame(g, filter, nextId);
        all.push(...r.cands);
        skippedNotes.push(...r.skipped);
        intels.push({ g, intel: r.intel });
      }
    }

    if (intels.length) {
      const s = summariseIntel(intels);
      const why = [...s.rejected].map(([k, n]) => `${n}× ${k}`).join("; ");
      await trace(runId, { layer: "scout", agent: "QUANT", message: `Market-anchored baseline on ${s.usable}/${intels.length} team games — ${s.withProjection} carry ESPN's independent win projection. Edges are measured against the vig-free price, never against win-loss records.`, mood: "info" });
      await trace(runId, { layer: "scout", agent: "MEDIC", message: `Injury effects priced on ${s.injurySpots} games${s.unchecked ? `; ${s.unchecked} games passed because their injury report could not be fetched` : ""}.`, mood: s.unchecked ? "warn" : "info" });
      await trace(runId, { layer: "scout", agent: "CHRONO", message: `${s.restSpots} games with a rest/schedule edge, shrunk to the unpriced remainder.`, mood: "info" });
      await trace(runId, { layer: "scout", agent: "SHARP", message: `${s.usable} boards validated${why ? `; passed on: ${why}` : ""}.`, mood: why ? "warn" : "success" });
    }
    if (bouts.length) {
      const withStats = bouts.filter((g) => g.combat?.dist.statsUsed).length;
      const withBook = bouts.filter((g) => g.combat?.priceSource === "espn").length;
      await trace(runId, {
        layer: "scout", agent: "MMA_EXPERT",
        message: `${bouts.length} bouts priced from one joint model (winner × method × round); fighter stats loaded for ${withStats}/${bouts.length}${withBook ? `; ESPN posted a real moneyline on ${withBook}` : "; no sportsbook price available, so every pick states its fair price and the price floor"}.`,
        mood: withStats === 0 ? "warn" : "info",
      });
    }
    if (!filter.mixed && [...filter.categories].some((c) => !COMBAT_CATEGORIES.has(c) && !["spread", "moneyline", "total"].includes(c))) {
      await trace(runId, { layer: "scout", agent: "PROPS", message: "Derived markets requested. ESPN's free feed has no posted line for these, so every one is a MODEL LINE with a line/price you must beat, held to a higher bar and staked smaller.", mood: "warn" });
    }

    // ---------------- Layer 3a: track-record gate ----------------
    let health: HealthReport;
    try {
      health = await loadHealth();
    } catch {
      health = { buckets: new Map(), globalBump: 0, overall: { ...NEUTRAL } };
    }
    const throttled = [...health.buckets].filter(([, h]) => h.status === "cold" || h.status === "frozen");
    if (throttled.length) {
      await trace(runId, { layer: "council", agent: "HISTORIAN",
        message: `Throttle engaged: ${throttled.map(([k, h]) => `${k} (${h.status})`).join(", ")}.`, mood: "warn" });
    }
    // When the engine has no graded picks yet, don't apply the globalBump.
    // A completely empty track record means the system is new and shouldn't be penalized.
    const globalBumpToUse = health.overall.n > 0 ? (health.globalBump ?? 0) : 0;
    await trace(runId, {
      layer: "council", agent: "HISTORIAN",
      message: health.overall.n === 0
        ? "No graded picks from the v5 engine yet — building a track record."
        : `v5 track record (28d): ${health.overall.note}.${throttled.length ? ` Throttled: ${throttled.map(([k, h]) => `${k} (${h.status})`).join(", ")}.` : " No bucket is cold."}${health.globalBump ? " Engine running cold — raising every bar by 1 point." : ""}`,
      mood: throttled.length || health.globalBump ? "warn" : "info",
    });

    // ---------------- Layer 2: bounded LLM review (optional) ----------------
    const perGameMax = filter.mixed ? 2 : 3;
    const common = { discipline, health: health.buckets, globalBump: globalBumpToUse, perGameMax };
    if (mode === "llm" && all.length) {
      const elapsed = Date.now() - t0;
      if (elapsed > 32_000) {
        await trace(runId, { layer: "analyst", agent: "STRATEGA", message: "Skipping LLM review — the slate took too long to load to stay inside the host's time limit. The deterministic card stands.", mood: "warn" });
      } else {
        const first = selectCard({ cands: all, ...common });
        const seen = new Set<number>();
        const shortlist: Candidate[] = [];
        const add = (c: Candidate) => {
          if (!seen.has(c.id) && shortlist.length < 18) {
            seen.add(c.id);
            shortlist.push(c);
          }
        };
        first.card.forEach(add);
        // A reviewer who trims a released pick can hand its slot to a substitute on the
        // same angle (e.g. the moneyline for a spread). Every plausible substitute must be
        // reviewed too, or an unreviewed number would take the slot at full probability.
        const slotKey = (c: Candidate) => `${c.game.sport}:${c.game.eventId}:${c.cluster}`;
        const held = new Set(first.card.map(slotKey));
        all.filter((c) => held.has(slotKey(c)) && c.ev > -0.03).forEach(add);
        nearMisses(first.rejected, 8).forEach((r) => add(r.c));
        const byExpert = new Map<string, Candidate[]>();
        for (const c of shortlist) {
          const k = expertKey(c.game.sport);
          byExpert.set(k, [...(byExpert.get(k) ?? []), c]);
        }
        const jobs: ReviewJob[] = [
          ...[...byExpert].map(([agentId, cands]) => ({ agentId, prompt: agentRow(agentId)?.prompt ?? "", cands })),
          { agentId: "analyst-stratega", prompt: agentRow("analyst-stratega")?.prompt ?? "", cands: shortlist },
          { agentId: "analyst-contrarian", prompt: agentRow("analyst-contrarian")?.prompt ?? "", cands: shortlist },
        ];
        const { reviews, log } = await collectReviews({ jobs, keys, enabled: llmEnabled, budgetMs: 20_000 });
        const named: SourcedReview[] = reviews.map((r) => ({ ...r, source: agentRow(r.source)?.codename ?? r.source }));
        const res = applyReviews(shortlist, named);
        for (const l of log) {
          await trace(runId, {
            layer: l.agentId.startsWith("analyst") ? "analyst" : "scout",
            agent: agentRow(l.agentId)?.codename ?? l.agentId,
            message: l.ok ? `Reviewed ${shortlist.length ? "the shortlist" : "nothing"} — ${l.note}${l.ms ? ` (${(l.ms / 1000).toFixed(1)}s)` : ""}.` : `No review this run — ${l.note}.`,
            mood: l.ok ? "info" : "warn",
          });
        }
        await trace(runId, {
          layer: "analyst", agent: "STRATEGA",
          message: `Review applied within hard bounds: ${res.vetoes} veto(es), ${res.trims} probability trim(s), ${res.boosts} small boost(s). Reviewers can't add picks or lines, and can't move a probability more than 5 points down or 2 up.`,
          mood: res.vetoes ? "warn" : "info",
        });
      }
    }

    // ---------------- Layer 3b: the council decides ----------------
    const { card, rejected, exposure } = selectCard({ cands: all, ...common });
    card.sort((a, b) => b.rank - a.rank);
    const near = nearMisses(rejected, 6);
    // Data gaps first: "we skipped this game because intel was missing" is the
    // most useful thing to tell a person, and must not be crowded out.
    const avoided = [
      ...skippedNotes.slice(0, 4),
      ...near.map((r) => `${r.c.game.matchup}: ${r.c.pick} — ${r.reason}`),
    ];

    for (const c of card) {
      const h = health.buckets.get(c.bucket) ?? NEUTRAL;
      c.signals = stampAgents(c, h);
    }

    let headline: string;
    let memo: string;
    if (card.length) {
      headline = `${card.length} PLAY${card.length === 1 ? "" : "S"} · ${exposure}u RISKED`;
      const priced = card.filter((c) => c.priceSource === "model").length;
      memo = `${card.length} play${card.length === 1 ? "" : "s"} cleared the bar from ${all.length} candidates across ${pre.length} games, risking ${exposure}u of the ${cfg.dailyCap}u ${cfg.label.toLowerCase()} cap. Stakes are quarter-Kelly on the estimated win probability at the real price, rounded down, with 1u = 1% of a 100u bankroll.${priced ? ` ${priced} ${priced === 1 ? "is" : "are"} model-priced: ESPN has no sportsbook number for ${priced === 1 ? "it" : "them"}, so check your book against the stated price floor before betting and log what you actually got in My Bets.` : ""}`;
    } else {
      headline = "PASS — NO PLAY CLEARS THE BAR";
      memo = `${all.length} candidate${all.length === 1 ? "" : "s"} across ${pre.length} games were priced and none cleared the ${cfg.label.toLowerCase()} bar (${(cfg.minEv * 100).toFixed(1)}% expected value after the vig, with independent confirmation). When the number on the screen is fair, the profitable decision is to pass. The closest calls are listed below; Loose discipline lowers the bar if you want more action.`;
    }
    await trace(runId, {
      layer: "council", agent: "RISK",
      message: card.length
        ? `Sized ${card.length} bets: ${card.map((c) => `${c.finalUnits}u`).join(" + ")} = ${exposure}u (daily cap ${cfg.dailyCap}u, per-game cap 2u, per-bet cap 2u / 1u model-priced).`
        : "Nothing to size — no candidate earned a stake.",
      mood: "info",
    });
    await trace(runId, {
      layer: "council", agent: "COMMISSIONER",
      message: card.length
        ? `Card released: ${card.map((c) => `${c.pick} (${pct(c.modelProb, 0)} · ${c.priceSource === "model" ? "model price" : `EV ${(c.ev * 100).toFixed(1)}%`})`).join(" | ")}`
        : "No card released today. This is a decision, not a failure.",
      mood: card.length ? "success" : "warn",
    });

    const decision: CouncilDecision = {
      headline, memo, avoided,
      discipline, exposure, considered: all.length, passed: all.length - card.length, noPlay: card.length === 0,
    };
    await finishRun(runId, ownerId, run.slateDate, decision, card, health.buckets);
  } catch (err) {
    await trace(runId, {
      layer: "system",
      agent: "KERNEL",
      message: `fault: ${err instanceof Error ? err.message : "unknown"}. Emergency shutdown.`,
      mood: "error",
    });
    await db.update(runs).set({ status: "failed", completedAt: new Date() }).where(eq(runs.id, runId));
  }
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

/** Stable identity of a wager: same bet on the same game = same key. */
export function dedupeKeyFor(
  slateDate: string,
  c: { game: { sport: string; eventId: string }; category: string; grade: GradeSpec },
): string {
  const g = c.grade;
  // Fight picks used to carry no segment; normalising keeps a v5 pick on the same
  // wager from being counted twice against one already on the ledger.
  const seg = g.segment === "FIGHT" ? "FULL" : (g.segment ?? "FULL");
  const parts = [
    slateDate,
    c.game.sport,
    c.game.eventId,
    c.category,
    g.side ?? "",
    g.line ?? "",
    g.teamAbbr ?? "",
    g.player ?? "",
    g.stat ?? "",
    seg,
  ];
  // Only where side + line don't already identify the wager.
  const m = g.mma;
  if (m?.kind === "method") parts.push(`${m.fighter}:${m.method}`);
  else if (m?.kind === "sigstr" || m?.kind === "td") parts.push(m.fighter);
  return parts.join("|");
}

async function finishRun(
  runId: number,
  ownerId: string,
  slateDate: string,
  decision: CouncilDecision,
  card: Candidate[],
  health: Map<string, BucketHealth>,
): Promise<void> {
  const repeats: NonNullable<CouncilDecision["repeats"]> = [];
  const carried: number[] = [];
  let released = 0;

  for (const c of card) {
    const key = dedupeKeyFor(slateDate, c);
    // Same wager identity already on the ledger? Acknowledge it instead of
    // inserting a clone — a duplicate row would settle a second time and
    // silently double-count the win or loss.
    const [existing] = await db
      .select({ id: predictions.id, runId: predictions.runId, outcome: predictions.outcome })
      .from(predictions)
      .where(eq(predictions.dedupeKey, key))
      .limit(1);

    if (existing) {
      carried.push(existing.id);
      repeats.push({ pick: c.pick, matchup: c.game.matchup, firstRunId: existing.runId, outcome: existing.outcome });
      continue;
    }

    const inserted = await db
      .insert(predictions)
      .values({
        ownerId,
        dedupeKey: key,
        runId,
        sortOrder: released,
        slateDate,
        sport: c.game.sport,
        eventId: c.game.eventId,
        matchup: c.game.matchup,
        startTime: c.game.startTime ? new Date(c.game.startTime) : null,
        category: c.category,
        pick: c.pick,
        lineLabel: c.lineLabel,
        odds: c.odds,
        units: c.finalUnits ?? sizeOf(c, health.get(c.bucket) ?? NEUTRAL),
        // v5: confidence is the estimated WIN PROBABILITY (%), edge is EV per unit (%)
        confidence: Math.round(c.modelProb * 1000) / 10,
        edge: Math.round(c.ev * 1000) / 10,
        modelProb: c.modelProb,
        marketProb: c.marketProb,
        priceSource: c.priceSource,
        minPrice: c.minOdds,
        engineVersion: ENGINE_VERSION,
        agents: c.signals,
        reasoning: c.discount ? `${c.thesis} Reviewers: ${c.discount}` : c.thesis,
        grade: c.grade,
        outcome: "pending",
      })
      // belt & braces: the unique index also blocks a race between two runs
      .onConflictDoNothing()
      .returning({ id: predictions.id });
    if (inserted.length) released++;
    else repeats.push({ pick: c.pick, matchup: c.game.matchup, firstRunId: runId, outcome: "pending" });
  }

  const finalDecision: CouncilDecision = { ...decision, repeats };
  if (repeats.length) {
    finalDecision.memo =
      `${decision.memo} ${repeats.length} of these ${repeats.length + released} selections were already staked on an earlier run — they are shown again here but stay graded once.`.trim();
  }

  // An empty run is KEPT. Under the old forced-ten-picks engine an empty run
  // meant "nothing happened" and was deleted — but now a pass is a deliberate,
  // informative result, and deleting it made the client's poll 404 and hang.
  await db
    .update(runs)
    .set({ status: "completed", council: finalDecision, carried, completedAt: new Date() })
    .where(eq(runs.id, runId));
}

// ---------------------------------------------------------------------------
// grading engine — settles pending bets against final scores, then pays the
// agents their rating adjustments
// ---------------------------------------------------------------------------

/** Legacy (v4) fight rows had no structured market; rebuild it from side/line. */
export function legacyMma(category: string, g: GradeSpec): MmaGrade | null {
  if (g.mma) return g.mma;
  if (category === "fight_ml" && (g.side === "home" || g.side === "away")) return { kind: "ml", fighter: g.side };
  // side "under" == wagered on a finish, "over" == wagered on a decision
  if (category === "fight_method") return { kind: "distance", yes: g.side === "over" };
  if (category === "fight_rounds" && g.line != null && (g.side === "over" || g.side === "under")) {
    return { kind: "rounds", dir: g.side, line: g.line };
  }
  return null;
}

const STALE_DAYS = 5;
const STATS_GRACE_DAYS = 3;

export async function gradePending(): Promise<{
  graded: number;
  wins: number;
  losses: number;
  pushes: number;
  voided: number;
}> {
  await ensureSchema();
  const pending = await db
    .select()
    .from(predictions)
    .where(and(eq(predictions.outcome, "pending"), lt(predictions.startTime, new Date(Date.now() - 45 * 60_000))))
    .orderBy(asc(predictions.id))
    .limit(250);
  const result = { graded: 0, wins: 0, losses: 0, pushes: 0, voided: 0 };
  if (!pending.length) return result;

  const finalsCache = new Map<string, FinalScore[]>();
  const creditList: GradedForRating[] = [];

  const record = async (
    p: (typeof pending)[number],
    outcome: Outcome,
    finalScore: string,
  ): Promise<void> => {
    await db
      .update(predictions)
      .set({ outcome, finalScore, gradedAt: new Date() })
      .where(eq(predictions.id, p.id));
    if (outcome === "void") {
      result.voided++;
      return;
    }
    result.graded++;
    if (outcome === "win") result.wins++;
    else if (outcome === "loss") result.losses++;
    else result.pushes++;
    // Only the canonical row of a wager credits agents (duplicates are never inserted).
    creditList.push({ agents: p.agents, outcome, modelProb: p.modelProb, confidence: p.confidence });
  };

  const ageDays = (p: (typeof pending)[number]): number =>
    p.startTime ? (Date.now() - p.startTime.getTime()) / 86_400_000 : 0;

  for (const p of pending) {
    try {
      const key = `${p.slateDate}|${p.sport}`;
      if (!finalsCache.has(key)) finalsCache.set(key, await getFinals(p.slateDate, p.sport));
      const f = finalsCache.get(key)!.find((x) => x.eventId === p.eventId);
      const g = p.grade as GradeSpec;

      if (!f || f.status !== "post") {
        // Postponed / cancelled / never reported: refund rather than hang forever.
        if (ageDays(p) > STALE_DAYS) await record(p, "void", `No result after ${STALE_DAYS} days — voided`);
        continue;
      }

      // ---------------- MMA ----------------
      if (p.category.startsWith("fight_")) {
        const mma = legacyMma(p.category, g);
        if (!mma) continue;
        let stats: FightStatsLike | null = null;
        if (mma.kind === "sigstr" || mma.kind === "td") {
          const ref = g.fightRef;
          const league = (ref?.league ?? f.league ?? "ufc") as "ufc" | "pfl";
          const cardId = ref?.cardId ?? f.cardId;
          const awayId = ref?.awayId ?? f.awayId ?? null;
          const homeId = ref?.homeId ?? f.homeId ?? null;
          if (cardId && awayId && homeId) {
            const [a, h] = await Promise.all([
              fetchFightStatLine(league, cardId, p.eventId, awayId),
              fetchFightStatLine(league, cardId, p.eventId, homeId),
            ]);
            stats = { away: a, home: h };
          }
        }
        const outcome = settleMma(mma, f, stats);
        if (outcome == null) {
          if (ageDays(p) > STATS_GRACE_DAYS) {
            await record(p, "void", "Fight stats were never published by the feed — voided (stake returned)");
          }
          continue;
        }
        await record(p, outcome, describeFight(f, stats));
        continue;
      }

      // ---------------- team sports ----------------
      let playerValue: number | null | undefined;
      if (p.category === "player_prop" && g.player && g.stat) {
        playerValue = await lookupPlayerStat(p.sport, p.eventId, g.player, g.stat);
      }
      const settled = settleTeam(p.category, g, f, playerValue);
      if (!settled) {
        if (ageDays(p) > STALE_DAYS) await record(p, "void", "Result data never became available — voided");
        continue;
      }
      await record(p, settled.outcome, settled.finalScore);
    } catch {
      /* leave it pending; the next sync retries */
    }
  }

  // settle agent ratings afterwards
  await settleAgentRatings(creditList);
  return result;
}
