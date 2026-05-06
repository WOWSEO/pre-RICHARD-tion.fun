import { Link } from "react-router-dom";
import type { MarketSummary } from "../services/apiClient";
import { useCountdown } from "../hooks/useCountdown";
import { formatMC } from "../services/marketData";

/**
 * One market in the predict list. Displays:
 *   - Schedule badge (15M / 1H / DAILY 7PM ET)
 *   - The full question
 *   - Live countdown to close
 *   - YES/NO price chips
 *   - Volume + open interest
 *
 * Click → /market/:id
 *
 * Accepts the server's wire format directly (closeAt as ISO string).
 */
export function MarketCard({ market }: { market: MarketSummary }) {
  const closeAtDate = new Date(market.closeAt);
  const { hh, mm, ss, expired } = useCountdown(closeAtDate);
  const status = market.status;
  const tradable = status === "open";
  // req 3: open + zero activity → "Waiting for first prediction"
  const awaitingFirstTrade = tradable && market.volume === 0 && market.openInterest === 0;

  const closeLabel = formatCloseLabel(closeAtDate);
  const targetMcLabel = formatMC(market.targetMc);

  return (
    <Link
      to={`/market/${market.id}`}
      className="group relative flex flex-col gap-4 rounded-3xl glass p-5 shadow-glass transition hover:-translate-y-0.5 hover:shadow-glass-lift sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <SchedulePill scheduleType={market.scheduleType} />
        <StatusBadge status={status} />
      </div>

      <p className="font-display text-lg font-semibold leading-snug tracking-tight text-ink-200 sm:text-xl">
        Will $TROLL be over{" "}
        <span className="bg-yes/30 px-1.5 py-0.5 rounded">{targetMcLabel}</span>{" "}
        MC at <span className="font-mono">{closeLabel}</span>?
      </p>

      <div className="grid grid-cols-2 gap-2.5">
        <PriceChip side="YES" cents={market.yesPriceCents} />
        <PriceChip side="NO" cents={market.noPriceCents} />
      </div>

      <div className="flex items-end justify-between border-t border-ink-200/10 pt-3 text-xs text-ink-100">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/60">
            {tradable ? "Closes in" : "Status"}
          </p>
          {tradable ? (
            <p className="font-mono text-base font-semibold tabular-nums text-ink-200">
              {expired ? "00:00:00" : `${hh}:${mm}:${ss}`}
            </p>
          ) : (
            // v20: never show the raw "locked" word.  Same translation as
            // StatusBadge above — internal `locked` is a brief
            // post-closeAt settlement window; users see "Closed".
            <p className="font-display text-sm font-semibold text-ink-200">
              {userFacingStatus(status)}
            </p>
          )}
        </div>
        <div className="text-right">
          {awaitingFirstTrade ? (
            <>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/60">
                Status
              </p>
              <p className="font-display text-sm font-semibold text-ink-200">
                Waiting for first prediction
              </p>
            </>
          ) : (
            <>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/60">
                Vol · OI
              </p>
              <p className="font-mono tabular-nums text-ink-200">
                {market.volume.toFixed(0)} · {market.openInterest.toFixed(0)}
              </p>
            </>
          )}
        </div>
      </div>

      <span
        aria-hidden
        className="pointer-events-none absolute right-5 top-5 text-ink-100/30 transition group-hover:text-ink-200 sm:right-6 sm:top-6"
      >
        ↗
      </span>
    </Link>
  );
}

function SchedulePill({ scheduleType }: { scheduleType: MarketSummary["scheduleType"] }) {
  const label =
    scheduleType === "15m" ? "15-min" : scheduleType === "hourly" ? "Hourly" : "Daily 7PM ET";
  const dot =
    scheduleType === "15m" ? "#3DFFFC" : scheduleType === "hourly" ? "#FFB23B" : "#B23BFF";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-200/8 px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.16em] text-ink-200 ring-1 ring-ink-200/10">
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dot }} aria-hidden />
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: MarketSummary["status"] }) {
  // v20 product rule: users never see the word "Locked".  Internally a
  // market sits in status="locked" between closeAt and the settlement
  // window's end (windowSeconds/2 long — 30s for 15m markets, 1m30s for
  // hourly, 7m30s for daily) while the engine collects close-time
  // snapshots.  That's correct lifecycle, but to users it's just
  // "closed" — no longer enterable, awaiting settlement.
  const map: Record<MarketSummary["status"], { label: string; cls: string }> = {
    open:     { label: "OPEN",     cls: "bg-yes/20 text-yes-deep ring-yes/30" },
    locked:   { label: "CLOSED",   cls: "bg-cyber-amber/20 text-cyber-amber ring-cyber-amber/30" },
    settling: { label: "SETTLING", cls: "bg-cyber-cyan/20 text-cyber-cyan ring-cyber-cyan/30" },
    settled:  { label: "SETTLED",  cls: "bg-ink-200/15 text-ink-200 ring-ink-200/15" },
    voided:   { label: "VOIDED",   cls: "bg-no/15 text-no-deep ring-no/30" },
  };
  const { label, cls } = map[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-mono font-semibold tracking-wider ring-1 ${cls}`}>
      {label}
    </span>
  );
}

function PriceChip({ side, cents }: { side: "YES" | "NO"; cents: number }) {
  const isYes = side === "YES";
  return (
    <div
      className={`relative flex items-baseline justify-between rounded-2xl px-3.5 py-3 ring-1 ${
        isYes
          ? "bg-yes/15 ring-yes/30 text-yes-deep"
          : "bg-no/15 ring-no/30 text-no-deep"
      }`}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.18em]">{side}</span>
      <span className="font-display text-xl font-bold tabular-nums">
        {cents.toFixed(1)}
        <span className="text-xs font-medium">¢</span>
      </span>
    </div>
  );
}

function formatCloseLabel(d: Date): string {
  // "16:30" or "Sun 7:00pm" — short and contextual
  const sameDay = new Date().toDateString() === d.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: false });
  }
  return d.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Map internal market.status enum to the user-facing label.
 *
 * Product rule (v20): users never see the word "Locked".  The `locked`
 * lifecycle status is a brief post-closeAt window during which the brain
 * is still collecting close-time snapshots — to users that's just "Closed."
 *
 *   open     → "Open"
 *   locked   → "Closed"      ← the only translation that matters here
 *   settling → "Settling"
 *   settled  → "Settled"
 *   voided   → "Voided"
 */
function userFacingStatus(status: MarketSummary["status"]): string {
  switch (status) {
    case "open":     return "Open";
    case "locked":   return "Closed";
    case "settling": return "Settling";
    case "settled":  return "Settled";
    case "voided":   return "Voided";
  }
}
