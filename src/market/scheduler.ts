import type { Market, ScheduleType } from "./marketTypes";
import { newAmmState, getPricesCents } from "./pricingEngine";

/**
 * Generates market objects on the allowed schedules, and advances market
 * lifecycle (open → locked → settling).
 *
 * Allowed schedules ONLY:
 *   - "15m"    : closes at :00, :15, :30, :45 of every hour
 *   - "hourly" : closes at :00 of every hour
 *   - "daily"  : closes at 19:00 America/New_York
 *
 * Lock timing (per spec):
 *   - 15m    locks 15s before close (= window/2 of 30s)
 *   - hourly locks 30s before close (= window/2 of 60s)
 *   - daily  locks 60s before close (= window/2 of 120s)
 *
 * Lock = (windowSeconds / 2) before close. The settlement window is centered
 * on the close time so snapshots are collected symmetrically around it.
 */

/**
 * Generate a primary-key for a new market.
 *
 * v56.1 — switched from a global in-memory counter (`_marketCounter`) to a
 * timestamp-based suffix.  The old counter reset on every Render redeploy,
 * causing PK collisions with old rows from previous server lifetimes
 * (manifested as `race_lost` results from the seeder for any coin/schedule
 * whose previous IDs landed in the new counter's range).  The previous
 * counter was also global across coins, so IDs were non-monotonic per
 * (coin, schedule) — see e.g. TROLL-15m-68 created after TROLL-15m-72 in
 * production data.
 *
 * The new format `{symbol}-{schedule}-{epoch36}{rand36}`:
 *   - `epoch36` is `Date.now().toString(36)` — monotonic by clock,
 *     8 chars at current time (~year 2059 before 9 chars).
 *   - `rand36` is a 4-char random suffix — protects against the
 *     vanishingly rare case of two markets created within the same ms.
 *   - Total ID length ~22-25 chars.  URL-safe (no slashes/colons).
 *
 * Old IDs (`TROLL-15m-68`) remain valid and unchanged in the DB.  This
 * change only affects newly-created markets going forward.
 */
function nextMarketId(symbol: string, schedule: ScheduleType): string {
  const epoch36 = Date.now().toString(36);
  const rand36 = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${symbol}-${schedule}-${epoch36}${rand36}`;
}

/** Window length in seconds for a given schedule. */
export function windowSecondsFor(schedule: ScheduleType): number {
  switch (schedule) {
    case "15m":
      return 30;
    case "hourly":
      return 60;
    case "daily":
      return 120;
  }
}

/** Poll cadence in seconds during the close window. */
export function pollCadenceFor(schedule: ScheduleType): number {
  return schedule === "daily" ? 10 : 5;
}

/** How many seconds before close trading locks. = windowSecondsFor / 2. */
export function lockOffsetSecondsFor(schedule: ScheduleType): number {
  return windowSecondsFor(schedule) / 2;
}

/** Returns the next 15-minute boundary strictly after `now`. */
export function nextQuarterHour(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  const minutes = d.getUTCMinutes();
  const next = Math.ceil((minutes + 1) / 15) * 15;
  if (next >= 60) {
    d.setUTCMinutes(0);
    d.setUTCHours(d.getUTCHours() + 1);
  } else {
    d.setUTCMinutes(next);
  }
  return d;
}

/** Returns the next top-of-hour strictly after `now`. */
export function nextTopOfHour(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  d.setUTCMinutes(0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d;
}

/**
 * Returns the next 19:00 in America/New_York after `now`.
 *
 * No date library deps. Strategy: for today + each of the next 2 UTC days, try
 * both EST (offset 5h) and EDT (offset 4h). Verify each candidate by formatting
 * back through Intl with the America/New_York timezone — only keep candidates
 * whose NY hour really is 19. Pick the smallest candidate strictly greater than
 * `now`.
 */
export function nextDailyClose(now: Date): Date {
  const candidates: Date[] = [];
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const base = new Date(now.getTime());
    base.setUTCDate(base.getUTCDate() + dayOffset);
    const y = base.getUTCFullYear();
    const m = base.getUTCMonth();
    const d = base.getUTCDate();
    for (const offsetHours of [4, 5]) {
      const cand = new Date(Date.UTC(y, m, d, 19 + offsetHours, 0, 0, 0));
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        hour12: false,
      });
      const part = fmt.formatToParts(cand).find((p) => p.type === "hour");
      if (!part) continue;
      const hourStr = part.value === "24" ? "00" : part.value;
      if (parseInt(hourStr, 10) === 19) candidates.push(cand);
    }
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  for (const c of candidates) if (c > now) return c;
  throw new Error("nextDailyClose: no candidate found (should be unreachable)");
}

export interface CreateMarketInput {
  symbol: string;
  scheduleType: ScheduleType;
  closeAt: Date;
  targetMc: number;
  /** Optional override for LMSR liquidity parameter. */
  b?: number;
  now?: Date;
}

/** Build a fresh open market. Caller is responsible for storing it. */
export function createMarket(input: CreateMarketInput): Market {
  const now = input.now ?? new Date();
  const windowSeconds = windowSecondsFor(input.scheduleType);
  const lockAt = new Date(input.closeAt.getTime() - (windowSeconds * 1000) / 2);
  const amm = newAmmState(input.b);
  const initialPrices = getPricesCents(amm);
  return {
    id: nextMarketId(input.symbol, input.scheduleType),
    symbol: input.symbol,
    question: `Will $${input.symbol} be over $${formatUsd(input.targetMc)} MC at ${input.closeAt.toISOString()}?`,
    targetMc: input.targetMc,
    closeAt: input.closeAt,
    lockAt,
    windowSeconds,
    pollCadenceSeconds: pollCadenceFor(input.scheduleType),
    scheduleType: input.scheduleType,
    status: "open",
    amm,
    yesPriceCents: initialPrices.yes,
    noPriceCents: initialPrices.no,
    yesLiquidity: 0,
    noLiquidity: 0,
    volume: 0,
    openInterest: 0,
    settlementMc: null,
    outcome: null,
    voidReason: null,
    positions: [],
    trades: [],
    createdAt: now,
    closedAt: null,
  };
}

// ----- Lifecycle -----

/**
 * Advances time-based transitions:
 *   open    → locked    when now ≥ market.closeAt
 *   locked  → settling  when now ≥ market.closeAt + windowSeconds/2
 *
 * Product-rule note (v17 onward):
 *   `lockAt` is no longer a behavioral cutoff for entry.  Users can predict
 *   any time before `closeAt`, including the final seconds of the window —
 *   the whole point of higher/lower markets is that conviction sharpens as
 *   close approaches.  The `lockAt` column is preserved on the wire for
 *   backwards compatibility (older clients still read it) but the brain
 *   now uses `closeAt` as the lock trigger.  Frontends that previously
 *   read lockAt for "is this enterable" checks should switch to closeAt.
 *
 * On the open → locked transition, every still-open position is also marked
 * "locked" (per spec position.status enum) — exits are gated on market.status,
 * but having the position status reflect reality keeps audit trails clean.
 *
 * settling → settled / voided is driven by the settlement engine.
 */
export function tick(market: Market, now: Date): void {
  if (market.status === "open" && now.getTime() >= market.closeAt.getTime()) {
    market.status = "locked";
    for (const p of market.positions) {
      if (p.status === "open") {
        p.status = "locked";
        p.updatedAt = now;
      }
    }
  }
  if (market.status === "locked") {
    const windowEnd =
      market.closeAt.getTime() + (market.windowSeconds * 1000) / 2;
    if (now.getTime() >= windowEnd) {
      market.status = "settling";
    }
  }
}

/**
 * True iff a user can enter this market right now.  Aligned with the
 * v17 product rule: gate on status === "open", which (after the
 * lockAt → closeAt change above) implicitly enforces "before closeAt".
 *
 * Defensive belt-and-braces: also re-checks closeAt directly in case a
 * caller queries before tick() ran on a stale in-memory market object.
 */
export function isTradingAllowed(market: Market): boolean {
  if (market.status !== "open") return false;
  if (Date.now() >= market.closeAt.getTime()) return false;
  return true;
}

/** Returns the [start, end] time range of the close window. */
export function closeWindow(market: Market): { start: Date; end: Date } {
  const halfMs = (market.windowSeconds * 1000) / 2;
  return {
    start: new Date(market.closeAt.getTime() - halfMs),
    end: new Date(market.closeAt.getTime() + halfMs),
  };
}

function formatUsd(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n.toFixed(0)}`;
}
