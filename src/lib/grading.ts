/**
 * Pure settlement logic. No I/O: the engine fetches finals (and, for the
 * volume props, per-fight stats) and hands them here, which keeps every rule
 * unit-testable — including the ugly cases (draws, no-contests, DQs, fights
 * stopped between rounds) where grading mistakes quietly cost real money.
 */

import type { GradeSpec, MmaGrade } from "../db/schema";

export type Outcome = "win" | "loss" | "push" | "void";

export type FightMethod = "ko" | "sub" | "dec" | "draw" | "nc" | "dq" | "unknown";

/**
 * Classify ESPN's free-text fight result ("KO/TKO", "Submission",
 * "Decision - Unanimous", ...). Order matters: a "technical decision" must not
 * be read as a TKO, and "no contest" must beat everything else.
 */
export function classifyFightResult(...texts: unknown[]): FightMethod {
  const t = texts
    .filter((x) => typeof x === "string" && x.trim() !== "")
    .join(" ")
    .toLowerCase();
  if (!t) return "unknown";
  if (/\bno[\s-]?contest\b|\bnc\b/.test(t)) return "nc";
  if (/disqualif|\bdq\b/.test(t)) return "dq";
  if (/\bdraw\b/.test(t)) return "draw";
  if (/decision|unanimous|\bsplit\b|majority|\bpoints\b/.test(t)) return "dec";
  if (/submission|\bsub\b|choke|armbar|triangle|guillotine|kimura|heel hook|rear[\s-]?naked|\btap/.test(t)) return "sub";
  if (/\bk\.?o\.?\b|\bt\.?k\.?o\.?\b|knock\s?out|doctor|stoppage|corner|retire|referee|punch|elbow|\bkick|strikes/.test(t)) return "ko";
  return "unknown";
}

export const methodLabel = (m: FightMethod | undefined, wentDistance?: boolean): string => {
  switch (m) {
    case "ko":
      return "KO/TKO";
    case "sub":
      return "Submission";
    case "dec":
      return "Decision";
    case "draw":
      return "Draw";
    case "nc":
      return "No contest";
    case "dq":
      return "DQ";
    default:
      return wentDistance ? "Decision" : "Finish";
  }
};

// ---------------------------------------------------------------------------
// MMA
// ---------------------------------------------------------------------------

export interface FightFinalLike {
  homeScore: number; // 1 = this fighter won
  awayScore: number;
  winnerName?: string;
  endRound?: number;
  elapsedMinutes?: number;
  scheduledRounds?: number;
  wentDistance?: boolean;
  method?: FightMethod;
}

export interface FightStatsLike {
  home: { sigStrikesLanded: number | null; takedownsLanded: number | null } | null;
  away: { sigStrikesLanded: number | null; takedownsLanded: number | null } | null;
}

type Side = "home" | "away";
const other = (s: Side): Side => (s === "home" ? "away" : "home");

const winnerOf = (f: FightFinalLike): Side | null =>
  f.homeScore === 1 ? "home" : f.awayScore === 1 ? "away" : null;

/** Effective method: a bout that went the distance is a decision even if ESPN omitted the text. */
function methodOf(f: FightFinalLike): FightMethod {
  if (f.method && f.method !== "unknown") return f.method;
  if (f.wentDistance) return "dec";
  return "unknown";
}

/** Minutes elapsed, with decisions pinned to the full scheduled time. */
function elapsedOf(f: FightFinalLike): number | null {
  const scheduled = f.scheduledRounds ?? 3;
  if (methodOf(f) === "dec" || methodOf(f) === "draw" || f.wentDistance) return scheduled * 5;
  return typeof f.elapsedMinutes === "number" ? f.elapsedMinutes : null;
}

/**
 * Highest round that actually started. A stoppage exactly on a round
 * boundary (5:00, 10:00, ...) happened between rounds, so the next round
 * never began.
 */
export function roundsStarted(elapsedMinutes: number): number {
  return Math.max(1, Math.ceil(elapsedMinutes / 5 - 1e-6));
}

/**
 * Settle an MMA pick. Returns null when we still need data (stat feed not
 * published yet, finish type unknown), so the caller leaves it pending.
 */
export function settleMma(
  mma: MmaGrade,
  f: FightFinalLike,
  stats?: FightStatsLike | null,
): Outcome | null {
  const method = methodOf(f);
  const winner = winnerOf(f);

  // A no-contest voids everything (the stake is returned).
  if (method === "nc") return "void";

  const elapsed = elapsedOf(f);

  switch (mma.kind) {
    case "ml": {
      if (!winner) return method === "draw" || method === "unknown" ? "push" : "void";
      return winner === mma.fighter ? "win" : "loss";
    }

    case "rounds": {
      if (elapsed == null) return null;
      const threshold = mma.line * 5;
      if (Math.abs(elapsed - threshold) < 0.02) return "push";
      return elapsed > threshold === (mma.dir === "over") ? "win" : "loss";
    }

    case "distance": {
      const went = f.wentDistance === true || method === "dec" || method === "draw";
      return went === mma.yes ? "win" : "loss";
    }

    case "start_round": {
      if (elapsed == null) return null;
      const started = roundsStarted(elapsed) >= mma.round;
      return started === mma.yes ? "win" : "loss";
    }

    case "spread": {
      if (method === "dq") return "void";
      const finishWin = (s: Side) => winner === s && method !== "dec" && method !== "draw";
      if (mma.line === -1.5) return finishWin(mma.fighter) ? "win" : "loss";
      // +1.5: covers unless the opponent wins by finish
      return finishWin(other(mma.fighter)) ? "loss" : "win";
    }

    case "method": {
      if (method === "dq") return "void";
      if (winner !== mma.fighter) return "loss"; // lost, or a draw
      if (method === "dec") return mma.method === "dec" ? "win" : "loss";
      if (method === "ko" || method === "sub") return mma.method === method ? "win" : "loss";
      // finish of unknown type
      if (mma.method === "dec") return "loss";
      return null; // can't tell KO from submission yet
    }

    case "sigstr":
    case "td": {
      const mine = stats?.[mma.fighter];
      const v = mma.kind === "sigstr" ? mine?.sigStrikesLanded : mine?.takedownsLanded;
      if (v == null || !Number.isFinite(v)) return null;
      if (v === mma.line) return "push";
      return v > mma.line === (mma.dir === "over") ? "win" : "loss";
    }
  }
}

/** Human-readable result line shown in the ledger. */
export function describeFight(f: FightFinalLike, stats?: FightStatsLike | null): string {
  const m = methodOf(f);
  const elapsed = elapsedOf(f);
  let when = "";
  if (m !== "dec" && m !== "draw" && elapsed != null && elapsed > 0) {
    const r = roundsStarted(elapsed);
    const within = elapsed - (r - 1) * 5;
    const mm = Math.floor(within);
    const ss = Math.round((within - mm) * 60);
    when = ` R${r} ${mm}:${String(Math.min(59, ss)).padStart(2, "0")}`;
  }
  const who = f.winnerName ? `${f.winnerName} def.` : "No winner";
  const extras: string[] = [];
  const total = (k: "sigStrikesLanded" | "takedownsLanded") => {
    const a = stats?.away?.[k];
    const h = stats?.home?.[k];
    return a != null && h != null ? `${a}-${h}` : null;
  };
  const sig = total("sigStrikesLanded");
  const td = total("takedownsLanded");
  if (sig) extras.push(`sig. strikes ${sig}`);
  if (td) extras.push(`TD ${td}`);
  return `${who} — ${methodLabel(m, f.wentDistance)}${when}${extras.length ? ` (${extras.join(" · ")})` : ""}`;
}

// ---------------------------------------------------------------------------
// team sports
// ---------------------------------------------------------------------------

export interface TeamFinalLike {
  homeAbbr: string;
  awayAbbr: string;
  homeScore: number;
  awayScore: number;
  homeLine: number[];
  awayLine: number[];
}

const cmp = (value: number, line: number, wantOver: boolean): Outcome =>
  value === line ? "push" : value > line === wantOver ? "win" : "loss";

function sliceLine(seg: string, line: number[]): number | null {
  if (!line.length) return null;
  if (seg === "1H") {
    // NCAAB-style halves have 2 entries; quarter sports need Q1 + Q2
    return line.length <= 2 ? line[0] : line[0] + line[1];
  }
  if (seg === "1Q" || seg === "P1" || seg === "1I") return line[0];
  if (seg === "F5") return line.slice(0, 5).reduce((s, n) => s + n, 0);
  return null;
}

export interface TeamSettlement {
  outcome: Outcome;
  finalScore: string;
}

/**
 * Settle a team-sport pick. `playerValue` is only needed for player props and
 * is looked up by the caller (a boxscore fetch). Returns null while data is
 * missing so the pick stays pending.
 */
export function settleTeam(
  category: string,
  g: GradeSpec,
  f: TeamFinalLike,
  playerValue?: number | null,
): TeamSettlement | null {
  const seg = g.segment ?? "FULL";
  const full = `${f.awayAbbr} ${f.awayScore} — ${f.homeAbbr} ${f.homeScore}`;

  if (seg !== "FULL") {
    const h = sliceLine(seg, f.homeLine);
    const a = sliceLine(seg, f.awayLine);
    if (h == null || a == null) return null; // linescore not published yet
    let outcome: Outcome | null = null;
    if (category === "1h_spread" && g.line != null) {
      const diff = g.side === "home" ? h + g.line - a : a + g.line - h;
      outcome = diff > 0 ? "win" : diff < 0 ? "loss" : "push";
    } else if (category === "nrfi") {
      const scored = h + a > 0;
      // side "under" == NRFI (no runs), "over" == YRFI
      outcome = (g.side === "under" && !scored) || (g.side === "over" && scored) ? "win" : "loss";
    } else if (g.line != null) {
      outcome = cmp(h + a, g.line, g.side === "over");
    }
    return outcome ? { outcome, finalScore: `${full} (${seg}: ${a}-${h})` } : null;
  }

  let outcome: Outcome | null = null;
  if (category === "spread" && g.line != null) {
    const adjHome = f.homeScore + (g.side === "home" ? g.line : 0);
    const adjAway = f.awayScore + (g.side === "away" ? g.line : 0);
    const diff = g.side === "home" ? adjHome - adjAway : adjAway - adjHome;
    outcome = diff > 0 ? "win" : diff < 0 ? "loss" : "push";
  } else if (category === "total" && g.line != null) {
    outcome = cmp(f.homeScore + f.awayScore, g.line, g.side === "over");
  } else if (category === "moneyline") {
    if (f.homeScore === f.awayScore) outcome = "push"; // a tie returns the stake
    else outcome = (f.homeScore > f.awayScore) === (g.side === "home") ? "win" : "loss";
  } else if (category === "team_total" && g.line != null && g.teamAbbr && !g.player) {
    const pts = g.teamAbbr === f.homeAbbr ? f.homeScore : f.awayScore;
    outcome = cmp(pts, g.line, g.side === "team_over");
  } else if (category === "player_prop" && g.player && g.stat && g.line != null) {
    if (playerValue == null) return null; // boxscore not parseable yet
    outcome = cmp(playerValue, g.line, g.side === "team_over");
  }
  return outcome ? { outcome, finalScore: full } : null;
}
