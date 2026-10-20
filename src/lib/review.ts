/**
 * Bounded LLM review.
 *
 * In the old pipeline the scouts' LLM output was only appended to a display
 * string (it never changed a pick), while the PROPS agent was asked to invent
 * player lines out of thin air and its inventions were released as picks.
 *
 * Here an LLM is a REVIEWER of candidates the engine already generated:
 *   - it can only refer to candidates by id — it cannot add a pick or a line;
 *   - it can veto, but only with a concrete reason;
 *   - it can trim the probability by at most 5 points, or add at most 2
 *     (caution is cheap, enthusiasm is not);
 *   - several reviewers run in parallel under one shared time budget, so a
 *     slow model can never push a run past the host's function timeout;
 *   - if no model is configured, or any call fails, the run simply proceeds on
 *     the deterministic engine — nothing depends on the LLM being right.
 */

import type { Candidate } from "./candidate";
import { fmtOdds, pct } from "./candidate";
import { clamp, evPerUnit } from "./edge";
import { llmJson, targetFor, type KeyBag } from "./llm";

export const MAX_TRIM = 0.05;
export const MAX_BOOST = 0.02;
export const MAX_TOTAL_TRIM = 0.06;
export const MIN_REASON_CHARS = 12;
export const MAX_VETO_SHARE = 0.4;

export type Verdict = "keep" | "trim" | "veto";

export interface Review {
  id: number;
  verdict: Verdict;
  deltaProb: number;
  reason: string;
}

export interface SourcedReview {
  source: string;
  review: Review;
}

export const REVIEW_RULES = `
You are a REVIEWER, not a picker. You may comment ONLY on the numbered candidates below. You cannot add picks, change lines, or invent prices.
Respond with ONLY this JSON (no prose):
{"reviews":[{"id":<candidate id>,"verdict":"keep"|"trim"|"veto","deltaProb":<number>,"reason":"<one concrete, checkable sentence>"}],"notes":"<one sentence>"}
Rules:
- "veto" only for a concrete problem visible in the data (a confirmed absence, a pitching/lineup change, a data error). Vague caution is NOT a reason.
- "trim": deltaProb between -0.05 and 0 when the model clearly overstates the pick.
- "keep": deltaProb between 0 and 0.02, only when the data clearly supports the pick beyond what the model already counted.
- Reference only facts present in the data. If you have nothing concrete to add, return {"reviews":[],"notes":"no concrete concerns"}.`;

/** Validate untrusted model output into safe, bounded reviews. */
export function parseReviews(raw: unknown, validIds: Set<number>): Review[] {
  const list = (raw as { reviews?: unknown })?.reviews;
  if (!Array.isArray(list)) return [];
  const out: Review[] = [];
  const seen = new Set<number>();
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    const id = Number(x.id);
    if (!Number.isInteger(id) || !validIds.has(id) || seen.has(id)) continue;
    const verdict = x.verdict === "veto" || x.verdict === "trim" || x.verdict === "keep" ? x.verdict : null;
    if (!verdict) continue;
    const reason = typeof x.reason === "string" ? x.reason.trim().slice(0, 240) : "";
    if (reason.length < MIN_REASON_CHARS) continue; // no reason, no effect
    let delta = Number(x.deltaProb);
    if (!Number.isFinite(delta)) delta = 0;
    if (verdict === "veto") delta = 0;
    else if (verdict === "trim") delta = clamp(delta > 0 ? -delta : delta, -MAX_TRIM, 0);
    else delta = clamp(delta, 0, MAX_BOOST);
    seen.add(id);
    out.push({ id, verdict, deltaProb: delta, reason });
  }
  return out;
}

export interface ApplyResult {
  vetoes: number;
  trims: number;
  boosts: number;
  ignored: number;
}

/**
 * Apply reviews from any number of reviewers. Deltas add up but the total is
 * clamped, and at most 40% of the shortlist may be vetoed per run so a
 * mis-prompted model cannot wipe out the card.
 */
export function applyReviews(cands: Candidate[], reviews: SourcedReview[]): ApplyResult {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const delta = new Map<number, number>();
  const notes = new Map<number, string[]>();
  const vetoWanted: { c: Candidate; reason: string }[] = [];
  const res: ApplyResult = { vetoes: 0, trims: 0, boosts: 0, ignored: 0 };

  for (const { source, review } of reviews) {
    const c = byId.get(review.id);
    if (!c) {
      res.ignored++;
      continue;
    }
    if (review.verdict === "veto") {
      vetoWanted.push({ c, reason: `${source}: ${review.reason}` });
      continue;
    }
    delta.set(c.id, (delta.get(c.id) ?? 0) + review.deltaProb);
    const list = notes.get(c.id) ?? [];
    list.push(`${source} ${review.deltaProb >= 0 ? "+" : ""}${(review.deltaProb * 100).toFixed(1)}pt: ${review.reason}`);
    notes.set(c.id, list);
  }

  const maxVetoes = Math.max(1, Math.floor(cands.length * MAX_VETO_SHARE));
  for (const v of vetoWanted.slice(0, maxVetoes)) {
    if (!v.c.vetoed) {
      v.c.vetoed = v.reason;
      res.vetoes++;
    }
  }
  res.ignored += Math.max(0, vetoWanted.length - maxVetoes);

  for (const [id, d] of delta) {
    const c = byId.get(id)!;
    const bounded = clamp(d, -MAX_TOTAL_TRIM, MAX_BOOST);
    if (Math.abs(bounded) < 1e-9) continue;
    c.modelProb = clamp(c.modelProb + bounded, 0.03, 0.97);
    c.ev = evPerUnit(c.modelProb, c.odds, c.pPush);
    c.rank += bounded * 100;
    c.discount = (notes.get(id) ?? []).join(" · ");
    if (bounded < 0) res.trims++;
    else res.boosts++;
  }
  return res;
}

// ---------------------------------------------------------------------------
// what the reviewer sees
// ---------------------------------------------------------------------------

function gameContext(c: Candidate): string {
  const g = c.game;
  const bits: string[] = [];
  if (g.injuries.length) {
    bits.push(
      "injuries: " +
        g.injuries
          .slice(0, 8)
          .map((i) => `${i.team} ${i.player} (${i.status})`)
          .join("; "),
    );
  }
  const pitchers = [...g.context.awayProbables, ...g.context.homeProbables]
    .slice(0, 4)
    .map((p) => `${p.name}${p.record ? ` ${p.record}` : ""}`);
  if (pitchers.length) bits.push(`probable starters: ${pitchers.join(" vs ")}`);
  if (g.rest) {
    const r = g.rest;
    const flags = [
      r.homeB2B && `${g.home.abbr} B2B`,
      r.awayB2B && `${g.away.abbr} B2B`,
      r.home3in4 && `${g.home.abbr} 3-in-4`,
      r.away3in4 && `${g.away.abbr} 3-in-4`,
    ].filter(Boolean);
    if (flags.length) bits.push(`rest: ${flags.join(", ")}`);
  }
  if (g.combat) {
    const m = g.combat.model;
    bits.push(
      `${g.combat.weightClass} ${g.combat.scheduledRounds}rd · ${g.away.record} vs ${g.home.record}${m.summary ? ` · ${m.summary}` : ""}`,
    );
  }
  return bits.join(" | ");
}

export function digestFor(cands: Candidate[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    const gk = `${c.game.sport}:${c.game.eventId}`;
    if (!seen.has(gk)) {
      seen.add(gk);
      lines.push(`\nGAME ${c.game.sportLabel} ${c.game.matchup}: ${gameContext(c) || "no extra context"}`);
    }
    lines.push(
      `  #${c.id} ${c.pick} [${c.category}] price ${fmtOdds(c.odds)}${c.priceSource === "model" ? " (model price)" : ""} | model ${pct(c.modelProb)}${c.marketProb != null ? ` vs market ${pct(c.marketProb)}` : ""} | EV ${(c.ev * 100).toFixed(1)}% | backed by ${c.signals.join(",") || "none"}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

export interface ReviewJob {
  agentId: string;
  /** the reviewer's own playbook (from the roster) */
  prompt: string;
  cands: Candidate[];
}

export interface ReviewLog {
  agentId: string;
  ok: boolean;
  note: string;
  ms: number;
  reviews: number;
}

export async function collectReviews(opts: {
  jobs: ReviewJob[];
  keys: KeyBag;
  enabled: boolean;
  /** total wall-clock the whole review stage may use */
  budgetMs: number;
}): Promise<{ reviews: SourcedReview[]; log: ReviewLog[] }> {
  const deadline = Date.now() + opts.budgetMs;
  const results = await Promise.all(
    opts.jobs.map(async (job): Promise<{ reviews: SourcedReview[]; log: ReviewLog }> => {
      const started = Date.now();
      const base = { agentId: job.agentId, ms: 0, reviews: 0 };
      if (!job.cands.length) return { reviews: [], log: { ...base, ok: true, note: "nothing to review" } };
      const target = targetFor(job.agentId, opts.keys, opts.enabled);
      if (!target) return { reviews: [], log: { ...base, ok: false, note: "no model configured" } };
      const remaining = deadline - Date.now();
      if (remaining < 3000) return { reviews: [], log: { ...base, ok: false, note: "out of time budget" } };
      const system = `${job.prompt}\n${REVIEW_RULES}`;
      const user = `Candidates to review:\n${digestFor(job.cands)}`;
      try {
        const raw = await llmJson(target, system, user, {
          timeoutMs: Math.min(22_000, remaining),
          temperature: 0.2,
        });
        const valid = new Set(job.cands.map((c) => c.id));
        const parsed = raw ? parseReviews(raw, valid) : [];
        const notes = typeof (raw as { notes?: unknown })?.notes === "string" ? String((raw as { notes: string }).notes).slice(0, 160) : "";
        return {
          reviews: parsed.map((review) => ({ source: job.agentId, review })),
          log: {
            agentId: job.agentId,
            ok: raw != null,
            note: raw == null ? "model returned nothing usable" : notes || `${parsed.length} review(s)`,
            ms: Date.now() - started,
            reviews: parsed.length,
          },
        };
      } catch (e) {
        return {
          reviews: [],
          log: { ...base, ok: false, note: e instanceof Error ? e.message.slice(0, 120) : "review failed", ms: Date.now() - started },
        };
      }
    }),
  );
  return { reviews: results.flatMap((r) => r.reviews), log: results.map((r) => r.log) };
}
