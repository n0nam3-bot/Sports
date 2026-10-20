"use client";

import { useMemo, useState } from "react";
import { evPerUnit, isAmerican, profitPerUnit, settledProfit } from "@/lib/edge";
import type { BetC } from "./types";
import { Chip, cx, fmtOdds } from "./ui";

export interface BetSavePayload {
  predictionId: number;
  stake: number;
  odds: number;
  note?: string;
}

/** The slice of a pick this control needs (works for ledger rows and War Room cards). */
export interface BetTarget {
  id: number;
  odds: number;
  units: number;
  outcome: string;
  modelProb?: number | null;
  priceSource?: string;
  minPrice?: number | null;
}

interface Props {
  pick: BetTarget;
  bet?: BetC;
  /** resolves to an error message, or null on success */
  onSave: (p: BetSavePayload) => Promise<string | null>;
  onRemove: (predictionId: number) => Promise<void>;
  /** tighter layout for ledger rows */
  compact?: boolean;
  /** start with the editor open (used when a parent row opens it) */
  defaultOpen?: boolean;
  /** called after a successful save, a cancel, or a removal */
  onDone?: () => void;
}

const QUICK_ODDS = [-110, -115, -120, 100, 110];
const QUICK_STAKES = [0.5, 1, 1.5, 2];

const fmtU = (n: number): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}u`;

/** A price is "worse" when it pays less per unit staked. */
const isWorse = (entered: number, floor: number): boolean => profitPerUnit(entered) < profitPerUnit(floor) - 1e-9;

export function BetControl({ pick, bet, onSave, onRemove, compact, defaultOpen, onDone }: Props) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [stake, setStake] = useState(String(bet?.stake ?? pick.units));
  const [odds, setOdds] = useState(String(bet?.odds ?? (pick.priceSource === "model" && pick.minPrice ? pick.minPrice : pick.odds)));
  const [note, setNote] = useState(bet?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const stakeN = Number(stake);
  const oddsN = Number(odds.replace("−", "-").replace("+", ""));
  const stakeOk = Number.isFinite(stakeN) && stakeN > 0 && stakeN <= 50;
  const oddsOk = isAmerican(oddsN);

  // Live read on the price the person is actually getting.
  const hint = useMemo(() => {
    if (!oddsOk) return null;
    const floor = pick.priceSource === "model" ? pick.minPrice ?? null : null;
    const ev = pick.modelProb != null ? evPerUnit(pick.modelProb, oddsN, 0) : null;
    return {
      ev,
      belowFloor: floor != null && isWorse(oddsN, floor),
      floor,
      toWin: stakeOk ? stakeN * profitPerUnit(oddsN) : null,
    };
  }, [oddsN, oddsOk, pick.modelProb, pick.priceSource, pick.minPrice, stakeN, stakeOk]);

  const flipSign = () => {
    const n = Number(odds.replace("−", "-"));
    if (Number.isFinite(n) && n !== 0) setOdds(String(-n));
  };

  const save = async () => {
    if (!stakeOk || !oddsOk) {
      setErr(!stakeOk ? "Stake must be between 0 and 50 units." : "Enter odds like -110 or +150.");
      return;
    }
    setBusy(true);
    setErr(null);
    const msg = await onSave({ predictionId: pick.id, stake: stakeN, odds: oddsN, note: note.trim() || undefined });
    setBusy(false);
    if (msg) setErr(msg);
    else {
      setOpen(false);
      onDone?.();
    }
  };

  // ---------------- already tracked ----------------
  if (bet && !open) {
    const settled = bet.result !== "pending";
    const tone = bet.result === "win" ? "green" : bet.result === "loss" ? "red" : "slate";
    return (
      <div className={cx("flex flex-wrap items-center gap-2", compact ? "" : "mt-3 border-t border-white/5 pt-3")}>
        <Chip tone="green">✓ TRACKING</Chip>
        <span className="font-mono text-[12px] font-bold text-slate-100">
          {bet.stake}u <span className="text-[#8fa3bd]">@</span> {fmtOdds(bet.odds)}
        </span>
        {settled ? (
          <Chip tone={tone}>
            {bet.result === "win" ? "WON" : bet.result === "loss" ? "LOST" : bet.result.toUpperCase()} {fmtU(bet.pnl)}
          </Chip>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8fa3bd]">to win {(bet.stake * profitPerUnit(bet.odds)).toFixed(2)}u</span>
        )}
        {bet.override && <Chip tone="amber">MANUAL RESULT</Chip>}
        {bet.late && <Chip tone="slate" className="!normal-case">logged after start</Chip>}
        <span className="ml-auto flex gap-1.5">
          <button onClick={() => setOpen(true)} className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#39d5ff] hover:brightness-150">
            edit
          </button>
          <button
            onClick={async () => {
              setBusy(true);
              await onRemove(pick.id);
              setBusy(false);
              onDone?.();
            }}
            disabled={busy}
            className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#ff4757] hover:brightness-150 disabled:opacity-40"
          >
            remove
          </button>
        </span>
      </div>
    );
  }

  // ---------------- collapsed: offer to track ----------------
  if (!open) {
    return (
      <div className={compact ? "" : "mt-3 border-t border-white/5 pt-3"}>
        <button
          onClick={() => setOpen(true)}
          className="clip-tag border border-[#37ff8b]/30 bg-[#37ff8b]/10 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#37ff8b] transition hover:brightness-150 active:scale-[0.98]"
        >
          + I bet this
        </button>
        <span className="ml-2 font-mono text-[10px] text-[#5f7089]">log your real stake &amp; price</span>
      </div>
    );
  }

  // ---------------- editor ----------------
  const evTone = hint?.ev == null ? "text-[#8fa3bd]" : hint.ev >= 0.02 ? "text-[#37ff8b]" : hint.ev >= 0 ? "text-[#39d5ff]" : "text-[#ff4757]";
  return (
    <div className={cx("rounded-md border border-[#37ff8b]/20 bg-[#050a14]/70 p-3", compact ? "" : "mt-3")}>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8fa3bd]">Your stake (units)</span>
          <input
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            inputMode="decimal"
            aria-label="stake in units"
            className="mt-1 w-full rounded border border-white/10 bg-[#0d1424] px-2.5 py-2 font-mono text-[14px] text-slate-100 outline-none focus:border-[#37ff8b]/50"
          />
          <span className="mt-1.5 flex flex-wrap gap-1">
            {[pick.units, ...QUICK_STAKES.filter((q) => q !== pick.units)].map((q, i) => (
              <button key={q} type="button" onClick={() => setStake(String(q))} className={cx("rounded border px-1.5 py-0.5 font-mono text-[10px]", i === 0 ? "border-[#37ff8b]/40 text-[#37ff8b]" : "border-white/10 text-[#8fa3bd]")}>
                {i === 0 ? `${q}u (suggested)` : `${q}u`}
              </button>
            ))}
          </span>
        </label>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8fa3bd]">Odds you got</span>
          <span className="mt-1 flex gap-1.5">
            <input
              value={odds}
              onChange={(e) => setOdds(e.target.value)}
              inputMode="text"
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="american odds"
              className="w-full rounded border border-white/10 bg-[#0d1424] px-2.5 py-2 font-mono text-[14px] text-slate-100 outline-none focus:border-[#37ff8b]/50"
            />
            <button type="button" onClick={flipSign} title="switch + / −" className="shrink-0 rounded border border-white/10 px-2.5 font-mono text-[14px] text-[#39d5ff]">
              ±
            </button>
          </span>
          <span className="mt-1.5 flex flex-wrap gap-1">
            {[pick.priceSource === "model" && pick.minPrice ? pick.minPrice : pick.odds, ...QUICK_ODDS]
              .filter((q, i, a) => a.indexOf(q) === i)
              .map((q, i) => (
                <button key={q} type="button" onClick={() => setOdds(String(q))} className={cx("rounded border px-1.5 py-0.5 font-mono text-[10px]", i === 0 ? "border-[#39d5ff]/40 text-[#39d5ff]" : "border-white/10 text-[#8fa3bd]")}>
                  {fmtOdds(q)}
                </button>
              ))}
          </span>
        </label>
      </div>

      {/* live read on the price */}
      <div className="mt-3 rounded border border-white/5 bg-white/[0.02] px-2.5 py-2 font-mono text-[11px] leading-relaxed">
        {!oddsOk ? (
          <span className="text-[#8fa3bd]">Enter the American odds your book gave you (like -110 or +150).</span>
        ) : (
          <>
            {hint?.toWin != null && (
              <span className="text-slate-300">
                Risk {stakeN}u to win <b className="text-slate-100">{hint.toWin.toFixed(2)}u</b>.{" "}
              </span>
            )}
            {hint?.ev != null ? (
              <span className={evTone}>
                At {fmtOdds(oddsN)} our {((pick.modelProb ?? 0) * 100).toFixed(0)}% estimate is worth{" "}
                <b>
                  {hint.ev >= 0 ? "+" : ""}
                  {(hint.ev * 100).toFixed(1)}% EV
                </b>
                {hint.ev < 0 ? " — this price isn't worth it; shop for a better one or pass." : hint.ev < 0.02 ? " — a thin edge." : "."}
              </span>
            ) : (
              <span className="text-[#8fa3bd]">Older pick: no stored probability, so there&apos;s no EV readout.</span>
            )}
            {hint?.belowFloor && hint.floor != null && (
              <span className="mt-1 block text-[#ffb020]">
                ⚠ That&apos;s worse than the {fmtOdds(hint.floor)} floor for this model-priced pick.
              </span>
            )}
          </>
        )}
      </div>

      <input
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, 200))}
        placeholder="note (optional) — which book, a different line…"
        aria-label="note"
        className="mt-3 w-full rounded border border-white/10 bg-[#0d1424] px-2.5 py-2 font-mono text-[12px] text-slate-100 placeholder:text-[#5f7089] outline-none focus:border-[#37ff8b]/50"
      />
      {err && <div className="mt-2 font-mono text-[11px] text-[#ff4757]">{err}</div>}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy || !stakeOk || !oddsOk}
          className="clip-tag border border-[#37ff8b]/40 bg-[#37ff8b]/15 px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#37ff8b] transition hover:brightness-150 disabled:cursor-not-allowed disabled:opacity-35"
        >
          {busy ? "saving…" : bet ? "update bet" : "save bet"}
        </button>
        <button onClick={() => { setOpen(false); setErr(null); onDone?.(); }} className="px-2 font-mono text-[11px] uppercase tracking-[0.16em] text-[#8fa3bd] hover:text-slate-200">
          cancel
        </button>
        {pick.outcome !== "pending" && (
          <span className="ml-auto font-mono text-[10px] text-[#5f7089]">
            graded: {pick.outcome} · {fmtU(settledProfit(pick.outcome, stakeOk ? stakeN : 0, oddsOk ? oddsN : -110))} at these numbers
          </span>
        )}
      </div>
    </div>
  );
}
