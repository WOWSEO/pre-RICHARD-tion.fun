import type { MarketSummary } from "./apiClient";
import type { ScheduleType } from "../market/marketTypes";

/**
 * Per-schedule market selection — applies the priority + recency rules
 * from the product spec exactly once, in one place, so all UI surfaces
 * (predict panel on App.tsx, home-page live preview, troll-page list)
 * agree on which market is "the current one" for a given schedule.
 *
 * Why one helper:
 *   The API may return multiple markets per schedule_type during normal
 *   lifecycle transitions (a fresh OPEN market alongside the previous
 *   VOIDED / SETTLED rows).  Without a shared rule, different pages would
 *   pick different rows and the user would see contradicting info.
 *
 * Selection rules (encoded below):
 *   1. Group by scheduleType — only consider rows for the requested slot.
 *   2. Walk this status priority ladder:
 *        open > locked > settling > settled > voided
 *      The first non-empty bucket wins.  Lower-priority statuses are
 *      NEVER considered when a higher-priority one exists for the slot —
 *      so an OPEN 15m beats every VOIDED 15m, every time.
 *   3. Within the chosen bucket, pick the row with the LATEST closeAt.
 *      If two OPEN markets exist for the same schedule (rare; the DB's
 *      partial unique index prevents this in steady state but it can
 *      happen in a brief race), the newer-closing one is the live one.
 */

const PANEL_SCHEDULES: ScheduleType[] = ["15m", "hourly", "daily"];

const STATUS_PRIORITY: Record<MarketSummary["status"], number> = {
  open: 0,
  locked: 1,
  settling: 2,
  settled: 3,
  voided: 4,
};

/** Returns the chosen market for a single schedule, or null if no rows exist. */
export function pickMarketForSchedule(
  all: readonly MarketSummary[],
  schedule: ScheduleType,
): MarketSummary | null {
  let best: MarketSummary | null = null;
  let bestRank = Infinity;
  for (const m of all) {
    if (m.scheduleType !== schedule) continue;
    const rank = STATUS_PRIORITY[m.status];
    if (rank > bestRank) continue;
    if (rank < bestRank) {
      best = m;
      bestRank = rank;
      continue;
    }
    // Same priority bucket — break the tie on closeAt (newer wins).
    if (new Date(m.closeAt).getTime() > new Date(best!.closeAt).getTime()) {
      best = m;
    }
  }
  return best;
}

/**
 * One slot per [15m, hourly, daily] in fixed order.  An entry's `market` is
 * null only when the API has zero rows for that schedule (cold start, never
 * seeded).  Use for the main predict panel where every slot must render.
 */
export function pickPanelMarkets(
  all: readonly MarketSummary[],
): Array<{ scheduleType: ScheduleType; market: MarketSummary | null }> {
  return PANEL_SCHEDULES.map((s) => ({
    scheduleType: s,
    market: pickMarketForSchedule(all, s),
  }));
}

/**
 * The 0-3 actively-tradable picks (one per schedule), filtered to OPEN or
 * LOCKED only — schedules whose top-priority pick is below LOCKED are
 * excluded so home-page "live markets" sections don't list stale voided
 * rows.  Order is fixed [15m, hourly, daily] for any present schedule.
 */
export function pickActivePanelMarkets(
  all: readonly MarketSummary[],
): MarketSummary[] {
  return PANEL_SCHEDULES.map((s) => pickMarketForSchedule(all, s)).filter(
    (m): m is MarketSummary => m != null && (m.status === "open" || m.status === "locked"),
  );
}
