import type { ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export const TONE: Record<string, { text: string; bg: string; border: string; glow: string }> = {
  green: { text: "text-[#37ff8b]", bg: "bg-[#37ff8b]/10", border: "border-[#37ff8b]/30", glow: "shadow-[0_0_14px_-2px_rgba(55,255,139,0.4)]" },
  cyan: { text: "text-[#39d5ff]", bg: "bg-[#39d5ff]/10", border: "border-[#39d5ff]/30", glow: "shadow-[0_0_14px_-2px_rgba(57,213,255,0.4)]" },
  violet: { text: "text-[#9d7bff]", bg: "bg-[#9d7bff]/10", border: "border-[#9d7bff]/30", glow: "shadow-[0_0_14px_-2px_rgba(157,123,255,0.4)]" },
  magenta: { text: "text-[#ff3d81]", bg: "bg-[#ff3d81]/10", border: "border-[#ff3d81]/30", glow: "shadow-[0_0_14px_-2px_rgba(255,61,129,0.4)]" },
  amber: { text: "text-[#ffb020]", bg: "bg-[#ffb020]/10", border: "border-[#ffb020]/30", glow: "shadow-[0_0_14px_-2px_rgba(255,176,32,0.4)]" },
  red: { text: "text-[#ff4757]", bg: "bg-[#ff4757]/10", border: "border-[#ff4757]/30", glow: "shadow-[0_0_14px_-2px_rgba(255,71,87,0.4)]" },
  slate: { text: "text-[#8fa3bd]", bg: "bg-[#8fa3bd]/10", border: "border-[#8fa3bd]/25", glow: "" },
};

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("panel scanlines", className)}>{children}</div>;
}

export function Chip({ tone = "slate", className, children }: { tone?: string; className?: string; children: ReactNode }) {
  const t = TONE[tone] ?? TONE.slate;
  return (
    <span className={cx("clip-tag inline-flex items-center gap-1 border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]", t.text, t.bg, t.border, className)}>
      {children}
    </span>
  );
}

export function ConfBar({ value }: { value: number }) {
  const segs = 10;
  const lit = Math.round((Math.max(40, Math.min(80, value)) - 40) / 40 * segs);
  const hot = value >= 64;
  const warm = value >= 58;
  const color = hot ? "#37ff8b" : warm ? "#39d5ff" : "#5b7290";
  return (
    <div className="flex h-2 items-stretch gap-[3px]" title={`confidence ${value.toFixed(0)}`}>
      {Array.from({ length: segs }, (_, i) => (
        <span
          key={i}
          className="conf-seg w-[10px]"
          style={{
            background: i < lit ? color : "rgba(120,150,200,0.14)",
            boxShadow: i < lit && hot ? `0 0 6px ${color}66` : undefined,
          }}
        />
      ))}
      <span className="ml-1.5 font-mono text-[11px] font-bold" style={{ color }}>{value.toFixed(0)}</span>
    </div>
  );
}

export function TeamMark({ src, abbr, size = 40 }: { src: string; abbr: string; size?: number }) {
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-[#0d1424]"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={abbr}
        width={size}
        height={size}
        className="h-[78%] w-[78%] object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]"
        loading="lazy"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
      <span className="absolute inset-0 -z-10 flex items-center justify-center font-mono text-[10px] font-bold text-[#5f7089]">{abbr}</span>
    </span>
  );
}

export function LadderBar({ wins, losses, pushes }: { wins: number; losses: number; pushes: number }) {
  const total = Math.max(1, wins + losses + pushes);
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/5">
      <span style={{ width: `${(wins / total) * 100}%` }} className="bg-[#37ff8b]" />
      <span style={{ width: `${(pushes / total) * 100}%` }} className="bg-[#5f7089]" />
      <span style={{ width: `${(losses / total) * 100}%` }} className="bg-[#ff4757]" />
    </div>
  );
}

export function NeonButton({
  children,
  onClick,
  tone = "green",
  disabled,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: string;
  disabled?: boolean;
  className?: string;
}) {
  const t = TONE[tone] ?? TONE.green;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "clip-tag group relative inline-flex items-center justify-center gap-2 border px-5 py-2.5 font-mono text-[12px] font-bold uppercase tracking-[0.18em] transition-all duration-200",
        t.text, t.bg, t.border,
        disabled
          ? "cursor-not-allowed opacity-35"
          : "hover:brightness-150 hover:saturate-150 active:scale-[0.98] " + t.glow,
        className,
      )}
    >
      <span className={cx("absolute inset-0", !disabled && "group-hover:shimmer")} />
      {children}
    </button>
  );
}

const CATEGORY_META: Record<string, { label: string; tone: string }> = {
  spread: { label: "SPREAD", tone: "cyan" },
  total: { label: "GAME TOTAL", tone: "violet" },
  moneyline: { label: "MONEYLINE", tone: "green" },
  team_total: { label: "TEAM PROP", tone: "amber" },
  player_prop: { label: "PLAYER PROP", tone: "magenta" },
  "1h_spread": { label: "1H SPREAD", tone: "cyan" },
  "1h_total": { label: "1H TOTAL", tone: "violet" },
  "1q_total": { label: "1Q TOTAL", tone: "violet" },
  p1_total: { label: "1ST PERIOD", tone: "violet" },
  f5_total: { label: "F5 INNINGS", tone: "amber" },
  nrfi: { label: "NRFI / YRFI", tone: "magenta" },
  fight_ml: { label: "FIGHT WINNER", tone: "green" },
  fight_method: { label: "METHOD", tone: "magenta" },
  fight_rounds: { label: "ROUND TOTAL", tone: "violet" },
};

export function CategoryChip({ category }: { category: string }) {
  const meta = CATEGORY_META[category] ?? { label: category.toUpperCase(), tone: "slate" };
  return <Chip tone={meta.tone}>{meta.label}</Chip>;
}

export function OutcomeChip({ outcome }: { outcome: string }) {
  const map: Record<string, { label: string; tone: string }> = {
    win: { label: "CASHED", tone: "green" },
    loss: { label: "BUSTED", tone: "red" },
    push: { label: "PUSH", tone: "slate" },
    void: { label: "VOID", tone: "slate" },
    pending: { label: "PENDING", tone: "amber" },
  };
  const m = map[outcome] ?? map.pending;
  return <Chip tone={m.tone} className={outcome === "pending" ? "blink" : ""}>{m.label}</Chip>;
}

export function LayerTag({ layer }: { layer: string }) {
  const tone = layer === "scout" ? "cyan" : layer === "analyst" ? "violet" : layer === "council" ? "magenta" : "green";
  return <Chip tone={tone}>{layer.toUpperCase()}</Chip>;
}
