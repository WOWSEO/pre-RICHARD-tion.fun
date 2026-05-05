import { useTrollMarketData } from "../hooks/useTrollMarketData";
import { formatMC } from "../services/marketData";

/**
 * Hero floating-card collage — the visual signature of the homepage.
 *
 * Each card is positioned absolutely at intentional rotations so they look
 * hand-arranged rather than grid-stamped. All sit over the cyberpunk video.
 *
 * Spec asked for these specific cards:
 *   - $TROLL MC
 *   - YES price
 *   - NO price
 *   - 15m market
 *   - hourly market
 *   - daily 7 PM ET market
 *   - connected holders
 *   - audit-backed settlement
 */
export function FloatingHeroCards({
  yesCents,
  noCents,
  totalUsers,
}: {
  yesCents: number;
  noCents: number;
  totalUsers: number;
}) {
  const { data } = useTrollMarketData();

  return (
    <div
      aria-hidden
      className="pointer-events-none relative mx-auto hidden h-[640px] max-w-[1280px] lg:block"
    >
      {/* TROLL MC — top-left, big */}
      <FloatCard
        style={{ top: 24, left: 12, transform: "rotate(-3deg)", animationDelay: "0s" }}
        speed="slow"
        size="md"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/70">
          $TROLL · live MC
        </p>
        <p className="mt-1 font-display text-3xl font-bold tabular-nums text-ink-200">
          {formatMC(data?.marketCapUsd) || "—"}
        </p>
        <p className="mt-1.5 text-xs text-ink-100/70">FDV displayed as MC</p>
      </FloatCard>

      {/* YES price — top center, neon green */}
      <FloatCard
        style={{ top: 4, left: "44%", transform: "rotate(2deg)", animationDelay: "0.2s" }}
        speed="med"
        size="sm"
        accent="yes"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-yes-deep">YES · Over</p>
        <p className="mt-1 font-display text-2xl font-bold tabular-nums text-yes-deep">
          {yesCents.toFixed(1)}¢
        </p>
      </FloatCard>

      {/* NO price — top-right, hot red */}
      <FloatCard
        style={{ top: 70, right: 24, transform: "rotate(-2deg)", animationDelay: "0.4s" }}
        speed="fast"
        size="sm"
        accent="no"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-no-deep">NO · Under</p>
        <p className="mt-1 font-display text-2xl font-bold tabular-nums text-no-deep">
          {noCents.toFixed(1)}¢
        </p>
      </FloatCard>

      {/* 15m market */}
      <FloatCard
        style={{ top: 230, left: 80, transform: "rotate(4deg)", animationDelay: "0.6s" }}
        speed="med"
        size="sm"
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-cyber-cyan/20 px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider text-ink-200 ring-1 ring-cyber-cyan/30">
          <span className="h-1.5 w-1.5 rounded-full bg-cyber-cyan" />
          15-min
        </span>
        <p className="mt-2 font-display text-base font-semibold leading-snug text-ink-200">
          Closes :00 :15 :30 :45
        </p>
      </FloatCard>

      {/* Hourly market */}
      <FloatCard
        style={{ top: 280, right: 100, transform: "rotate(-3deg)", animationDelay: "0.8s" }}
        speed="slow"
        size="sm"
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-cyber-amber/20 px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider text-ink-200 ring-1 ring-cyber-amber/30">
          <span className="h-1.5 w-1.5 rounded-full bg-cyber-amber" />
          Hourly
        </span>
        <p className="mt-2 font-display text-base font-semibold leading-snug text-ink-200">
          Top of every hour
        </p>
      </FloatCard>

      {/* Daily market */}
      <FloatCard
        style={{ top: 440, left: 240, transform: "rotate(2deg)", animationDelay: "1s" }}
        speed="med"
        size="md"
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-cyber-magenta/20 px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider text-ink-200 ring-1 ring-cyber-magenta/30">
          <span className="h-1.5 w-1.5 rounded-full bg-cyber-magenta" />
          Daily 7PM ET
        </span>
        <p className="mt-2 font-display text-lg font-bold leading-snug text-ink-200">
          The headline market
        </p>
        <p className="mt-1 text-xs text-ink-100/70">7:00 PM America/New_York close · 120s settlement window</p>
      </FloatCard>

      {/* Connected holders */}
      <FloatCard
        style={{ top: 460, right: 40, transform: "rotate(-4deg)", animationDelay: "1.2s" }}
        speed="fast"
        size="sm"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/70">
          Holders predicting
        </p>
        <p className="mt-1 font-display text-2xl font-bold tabular-nums text-ink-200">
          {totalUsers.toString().padStart(3, "0")}
        </p>
      </FloatCard>

      {/* Audit settlement */}
      <FloatCard
        style={{ top: 130, left: 480, transform: "rotate(-1deg)", animationDelay: "1.4s" }}
        speed="slow"
        size="sm"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/70">
          Settlement
        </p>
        <p className="mt-1 font-display text-base font-semibold leading-snug text-ink-200">
          Median of two oracles<br />
          sha256 audit receipts
        </p>
      </FloatCard>
    </div>
  );
}

function FloatCard({
  children,
  style,
  speed,
  size,
  accent,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  speed: "slow" | "med" | "fast";
  size: "sm" | "md";
  accent?: "yes" | "no";
}) {
  const sizeCls = size === "md" ? "min-w-[230px] p-5" : "min-w-[180px] p-4";
  const accentCls =
    accent === "yes"
      ? "ring-yes/40 shadow-yes-glow"
      : accent === "no"
        ? "ring-no/40 shadow-no-glow"
        : "ring-cream-100/30 shadow-glass";
  const animCls =
    speed === "slow" ? "animate-float-slow" : speed === "fast" ? "animate-float-fast" : "animate-float-med";
  return (
    <div
      className={`absolute glass rounded-2xl ring-1 ${accentCls} ${sizeCls} ${animCls} animate-fade-up`}
      style={style}
    >
      {children}
    </div>
  );
}
