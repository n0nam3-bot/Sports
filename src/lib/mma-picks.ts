/**
 * MMA candidate generation. Every market the app offers for UFC / DWCS / PFL is
 * derived from the single joint model in `mma-model.ts`:
 *
 *   moneyline · finish handicap ("point spread") · total rounds (0.5–4.5) ·
 *   goes / doesn't go the distance · fight to start round 2–5 ·
 *   method of victory (KO/TKO, submission, decision) ·
 *   significant strikes landed · takedowns landed
 *
 * ESPN publishes no sportsbook price for these (except, occasionally, a
 * moneyline), so almost every MMA pick is MODEL-PRICED. We therefore do not
 * pretend to know the edge. Each pick carries the probability we estimate, our
 * fair price, and the worst price at which it is still a play. The tracker then
 * compares that to the price the person actually got.
 *
 * To avoid recommending things any generic fight would satisfy, a pick must
 * also differ from the division base rate by a margin — i.e. the call has to
 * reflect something specific about these two fighters.
 */

import type { GameInfo } from "./espn";
import type { BetCategory, GradeSpec, MmaGrade } from "../db/schema";
import { allowsCandidate, mmaMarketKey, type MarketFilter } from "./markets";
import { DISCIPLINES, type Discipline } from "./discipline";
import { bucketOf, fmtOdds, pct, type Candidate } from "./candidate";
import { clamp, devigTwoWay, evPerUnit, fairAmerican, minAcceptableAmerican } from "./edge";
import {
  buildMmaModel,
  halfLine,
  pFinishSpread,
  pMethod,
  pReach,
  pRoundsOver,
  pSigStrikesOver,
  pTakedownsOver,
  roundLines,
  sigStrikesBaseline,
  sigStrikesMean,
  takedownsBaseline,
  takedownsMean,
  type Method,
  type MmaModel,
  type Side,
} from "./mma-model";

/** How much we trust our own probability when sizing a model-priced MMA pick. */
export const MMA_TRUST = 0.4;
/** With a real posted moneyline we trust the model a bit more, but still lean on the market. */
const MMA_BOOK_TRUST = 0.7;
const BLEND_TO_MODEL = 0.35;
const CUSHION = 0.035;
/**
 * No heavy chalk on a number we invented: above ~75% the price floor is steeper
 * than about -250, where one loss erases three wins and the unproven model
 * would have to be right to within a couple of points to still have value.
 */
const P_MAX = 0.75;

const P_MIN = {
  ml: 0.62,
  rounds: 0.62,
  distance: 0.62,
  start: 0.66,
  spread: 0.58,
  method: 0.4,
  sigstr: 0.58,
  td: 0.58,
} as const;

type Kind = keyof typeof P_MIN;

export interface MmaEval {
  cands: Candidate[];
  skipped: string[];
}

const METHOD_LABEL: Record<Method, string> = { ko: "KO/TKO", sub: "submission", dec: "decision" };

function neutralModel(g: GameInfo): MmaModel {
  const c = g.combat!;
  return buildMmaModel({
    weightClass: c.weightClass,
    scheduledRounds: c.scheduledRounds,
    promotion: c.promotion,
    away: { record: "0-0", profile: null },
    home: { record: "0-0", profile: null },
  });
}

/** Keep the legacy `side`/`line` fields meaningful for MMA rows. */
function legacyGrade(mma: MmaGrade): Pick<GradeSpec, "side" | "line"> {
  switch (mma.kind) {
    case "ml":
      return { side: mma.fighter, line: null };
    case "rounds":
      return { side: mma.dir, line: mma.line };
    case "distance":
      return { side: mma.yes ? "over" : "under", line: null };
    case "start_round":
      return { side: mma.yes ? "over" : "under", line: mma.round };
    case "spread":
      return { side: mma.fighter, line: mma.line };
    case "method":
      return { side: mma.fighter, line: null };
    case "sigstr":
    case "td":
      return { side: mma.dir, line: mma.line };
  }
}

const CATEGORY_OF: Record<MmaGrade["kind"], BetCategory> = {
  ml: "fight_ml",
  rounds: "fight_rounds",
  distance: "fight_distance",
  start_round: "fight_start_round",
  spread: "fight_spread",
  method: "fight_method_win",
  sigstr: "fight_sigstr",
  td: "fight_td",
};

const CLUSTER_OF: Record<MmaGrade["kind"], (m: MmaGrade) => string> = {
  ml: () => "result",
  spread: () => "result",
  method: () => "result",
  rounds: () => "duration",
  distance: () => "duration",
  start_round: () => "duration",
  sigstr: (m) => `sigstr:${(m as Extract<MmaGrade, { kind: "sigstr" }>).fighter}`,
  td: (m) => `td:${(m as Extract<MmaGrade, { kind: "td" }>).fighter}`,
};

export function evaluateBout(
  g: GameInfo,
  filter: MarketFilter,
  nextId: () => number,
  discipline: Discipline,
): MmaEval {
  const c = g.combat;
  const out: MmaEval = { cands: [], skipped: [] };
  if (!c) return out;
  const cfg = DISCIPLINES[discipline];
  const m = c.dist;
  const base = neutralModel(g);
  const stats = m.statsUsed;
  const who: Record<Side, string> = { home: g.home.name, away: g.away.name };
  // Full names, not the surname-token abbreviations: two fighters can share a last name or a "Jr.".
  const tag = `${g.away.name} vs ${g.home.name}`;
  const evidence = stats
    ? "ESPN career stats + records"
    : "records only (ESPN fighter stats unavailable)";

  const floor = (k: Kind): number =>
    clamp(P_MIN[k] + cfg.probShift + (stats ? 0 : k === "ml" ? 0.06 : 0.02), 0.3, 0.9);

  const fightRef = {
    league: (c.league === "pfl" ? "pfl" : "ufc") as "ufc" | "pfl",
    cardId: c.eventId,
    homeId: c.fighterIds.home,
    awayId: c.fighterIds.away,
  };

  /** Build a model-priced candidate if it clears both bars. */
  const consider = (
    kind: Kind,
    mma: MmaGrade,
    p: number,
    pBase: number,
    pick: string,
    lineLabel: string,
    thesis: string,
    playRule = "",
  ): void => {
    const key = mmaMarketKey(mma);
    const category = CATEGORY_OF[mma.kind];
    if (!allowsCandidate(filter, category, undefined, key)) return;
    if (p < floor(kind) || p > P_MAX) return;
    if (p - pBase < cfg.minDeviation) return;
    const minOdds = minAcceptableAmerican(p, CUSHION);
    const fair = fairAmerican(p);
    const grade: GradeSpec = { ...legacyGrade(mma), segment: "FIGHT", mma, fightRef };
    out.cands.push({
      id: nextId(),
      game: g,
      category,
      pick,
      lineLabel,
      odds: minOdds,
      priceSource: "model",
      modelProb: p,
      pPush: 0,
      marketProb: null,
      fairOdds: fair,
      minOdds,
      ev: evPerUnit(p, minOdds, 0),
      trust: MMA_TRUST,
      signals: stats ? ["MMA_EXPERT", "QUANT"] : ["MMA_EXPERT"],
      agree: stats ? 2 : 1,
      thesis: `${thesis} Division base rate ${pct(pBase)}; ${evidence}. MODEL PRICE: fair ${fmtOdds(fair)}. ${playRule}Play it at ${fmtOdds(minOdds)} or better — your book sets the real price, so check it before you bet.`,
      grade,
      key,
      bucket: bucketOf(g.sport, category),
      cluster: CLUSTER_OF[mma.kind](mma),
      rank: 60 * (p - pBase) + 40 * (p - 0.5),
    });
  };

  // ---------------- moneyline ----------------
  if (allowsCandidate(filter, "fight_ml", undefined, "ml")) {
    const real = g.odds && g.odds.homeML != null && g.odds.awayML != null ? g.odds : null;
    if (real) {
      // ESPN published a real moneyline: price it against the market (vig removed),
      // leaning mostly on the market and only partly on our model.
      const [mktHome] = devigTwoWay(real.homeML!, real.awayML!);
      const pHome = mktHome + BLEND_TO_MODEL * (m.pHome - mktHome);
      const sides = (["home", "away"] as const).map((side) => {
        const price = side === "home" ? real.homeML! : real.awayML!;
        const pWin = side === "home" ? pHome : 1 - pHome;
        const mp = side === "home" ? mktHome : 1 - mktHome;
        return { side, price, pWin, mp, ev: evPerUnit(pWin, price, 0) };
      });
      const best = sides.reduce((x, y) => (y.ev > x.ev ? y : x));
      const mma: MmaGrade = { kind: "ml", fighter: best.side };
      const grade: GradeSpec = { ...legacyGrade(mma), segment: "FIGHT", mma, fightRef };
      out.cands.push({
        id: nextId(),
        game: g,
        category: "fight_ml",
        pick: `${who[best.side]} ML`,
        lineLabel: `ML ${fmtOdds(best.price)}`,
        odds: best.price,
        priceSource: "book",
        modelProb: best.pWin,
        pPush: 0,
        marketProb: best.mp,
        fairOdds: fairAmerican(best.pWin),
        minOdds: null,
        ev: best.ev,
        trust: MMA_BOOK_TRUST,
        signals: stats ? ["MMA_EXPERT", "QUANT", "SHARP"] : ["MMA_EXPERT", "SHARP"],
        agree: stats ? 2 : 1,
        thesis: `ESPN posts ${who[best.side]} at ${fmtOdds(best.price)} (${pct(best.mp)} with the vig removed). Our fighter model sees ${pct(best.side === "home" ? m.pHome : m.pAway)}; blended 35% toward the model = ${pct(best.pWin)}. ${evidence}.`,
        grade,
        key: "ml",
        bucket: bucketOf(g.sport, "fight_ml"),
        cluster: "result",
        rank: best.ev * 100 + 10 * (best.pWin - 0.5),
      });
    } else {
      const side: Side = m.pHome >= m.pAway ? "home" : "away";
      const p = side === "home" ? m.pHome : m.pAway;
      consider(
        "ml",
        { kind: "ml", fighter: side },
        p,
        0.5,
        `${who[side]} ML`,
        "ML",
        `Fighter model makes ${who[side]} ${pct(p)} to win (${pct(m.pFinish, 0)} chance the fight is finished).`,
      );
    }
  }

  // ---------------- total rounds: over / under every line the bout can offer ----------------
  for (const L of roundLines(m.rounds)) {
    const po = pRoundsOver(m, L);
    if (!Number.isFinite(po)) continue;
    const over = po >= 0.5;
    const p = over ? po : 1 - po;
    const pb = pRoundsOver(base, L);
    consider(
      "rounds",
      { kind: "rounds", dir: over ? "over" : "under", line: L },
      p,
      over ? pb : 1 - pb,
      `${tag} — ${over ? "over" : "under"} ${L} rounds`,
      `${over ? "o" : "u"}${L} rounds`,
      `Model: ${pct(m.pFinish, 0)} finish / ${pct(m.pDecision, 0)} decision, ~${(m.expectedMinutes / 5).toFixed(1)} rounds expected in this ${m.rounds}-rounder → ${pct(p)} ${over ? "over" : "under"} ${L}.`,
      over ? `Over only at a line of ${L} or lower. ` : `Under only at a line of ${L} or higher. `,
    );
  }

  // ---------------- goes / doesn't go the distance ----------------
  {
    const yes = m.pDecision >= 0.5;
    const p = yes ? m.pDecision : 1 - m.pDecision;
    const pb = yes ? base.pDecision : 1 - base.pDecision;
    consider(
      "distance",
      { kind: "distance", yes },
      p,
      pb,
      `${tag} — ${yes ? "goes the distance" : "does not go the distance"}`,
      yes ? "goes distance" : "ends early",
      `Model: ${pct(m.pDecision, 0)} chance this reaches the scorecards, ${pct(m.pFinish, 0)} it ends inside the distance → ${pct(p)} ${yes ? "goes the distance" : "finishes early"}.`,
    );
  }

  // ---------------- fight to start round N (yes / no) ----------------
  for (let k = 2; k <= m.rounds; k++) {
    const pr = pReach(m, k);
    const yes = pr >= 0.5;
    const p = yes ? pr : 1 - pr;
    const pb = yes ? pReach(base, k) : 1 - pReach(base, k);
    consider(
      "start",
      { kind: "start_round", round: k, yes },
      p,
      pb,
      `${tag} — fight ${yes ? "starts" : "does not start"} round ${k}`,
      `${yes ? "starts" : "ends before"} R${k}`,
      `Model: ${pct(pr, 0)} the bout is still going when round ${k} begins → ${pct(p)} ${yes ? "yes" : "no"}.`,
    );
  }

  // The remaining markets need real fighter data to say anything specific.
  if (!stats) {
    if (out.cands.length === 0)
      out.skipped.push(`${tag}: no edge from records alone (ESPN fighter stats unavailable)`);
    return out;
  }

  // ---------------- point spread (finish handicap) ----------------
  for (const fighter of ["home", "away"] as const) {
    for (const line of [-1.5, 1.5] as const) {
      const p = pFinishSpread(m, fighter, line);
      const pb = pFinishSpread(base, fighter, line);
      consider(
        "spread",
        { kind: "spread", fighter, line },
        p,
        pb,
        `${who[fighter]} ${line > 0 ? "+1.5" : "−1.5"} (${line > 0 ? "wins or isn't finished" : "must win by finish"})`,
        `spread ${line > 0 ? "+" : "−"}1.5`,
        line > 0
          ? `Finish handicap: +1.5 covers unless ${who[fighter === "home" ? "away" : "home"]} finishes the fight. Model: ${pct(p)} to cover.`
          : `Finish handicap: −1.5 needs ${who[fighter]} to win by KO/TKO or submission. Model: ${pct(p)}.`,
      );
    }
  }

  // ---------------- method of victory ----------------
  for (const fighter of ["home", "away"] as const) {
    for (const method of ["ko", "sub", "dec"] as const) {
      const p = pMethod(m, fighter, method);
      const pb = pMethod(base, fighter, method);
      consider(
        "method",
        { kind: "method", fighter, method },
        p,
        pb,
        `${who[fighter]} by ${METHOD_LABEL[method]}`,
        `by ${METHOD_LABEL[method]}`,
        `Model: ${pct(m.method[fighter].ko)} KO/TKO · ${pct(m.method[fighter].sub)} sub · ${pct(m.method[fighter].dec)} decision for ${who[fighter]} (overall win ${pct(fighter === "home" ? m.pHome : m.pAway, 0)}).`,
      );
    }
  }

  // ---------------- significant strikes + takedowns (per fighter) ----------------
  for (const fighter of ["home", "away"] as const) {
    // significant strikes landed
    {
      const mean = sigStrikesMean(m, fighter);
      const baseMean = sigStrikesBaseline(m, fighter);
      const gap = (mean - baseMean) / Math.max(baseMean, 1);
      if (Math.abs(gap) >= 0.07) {
        const over = gap > 0;
        const line = halfLine(baseMean);
        const po = pSigStrikesOver(m, fighter, line);
        const p = over ? po : 1 - po;
        const ladder = [-5, 0, 5]
          .map((d) => {
            const L = Math.max(0.5, line + d);
            return `${L}→${pct(pSigStrikesOver(m, fighter, L), 0)}`;
          })
          .join(" · ");
        consider(
          "sigstr",
          { kind: "sigstr", fighter, dir: over ? "over" : "under", line },
          p,
          0.5, // the line is set at this fighter's own baseline, so the baseline is a coin flip
          `${who[fighter]} ${over ? "over" : "under"} ${line} sig. strikes`,
          `${over ? "o" : "u"}${line} sig str`,
          `Model projects ~${mean.toFixed(0)} significant strikes landed vs a ~${baseMean.toFixed(0)} career-pace line (${gap > 0 ? "+" : ""}${(gap * 100).toFixed(0)}%). P(over) by line: ${ladder}.`,
          over ? `Over only at a line of ${line} or lower. ` : `Under only at a line of ${line} or higher. `,
        );
      }
    }
    // takedowns landed
    {
      const mean = takedownsMean(m, fighter);
      const baseMean = takedownsBaseline(m, fighter);
      const diff = mean - baseMean;
      if (Math.abs(diff) >= 0.25 && Math.abs(diff) / Math.max(baseMean, 0.5) >= 0.15) {
        const over = diff > 0;
        const line = halfLine(baseMean);
        const po = pTakedownsOver(m, fighter, line);
        const p = over ? po : 1 - po;
        const ladder = [-1, 0, 1]
          .map((d) => {
            const L = Math.max(0.5, line + d);
            return `${L}→${pct(pTakedownsOver(m, fighter, L), 0)}`;
          })
          .join(" · ");
        consider(
          "td",
          { kind: "td", fighter, dir: over ? "over" : "under", line },
          p,
          0.5,
          `${who[fighter]} ${over ? "over" : "under"} ${line} takedowns`,
          `${over ? "o" : "u"}${line} TD`,
          `Model projects ~${mean.toFixed(1)} takedowns landed vs a ~${baseMean.toFixed(1)} baseline. P(over) by line: ${ladder}.`,
          over ? `Over only at a line of ${line} or lower. ` : `Under only at a line of ${line} or higher. `,
        );
      }
    }
  }

  // (A bout with nothing specific to say is the normal case, not a data problem — no note.)
  return out;
}
