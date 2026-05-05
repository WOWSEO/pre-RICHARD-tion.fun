import type { MarketSummary } from "./apiClient";
import type { ScheduleType } from "../market/marketTypes";

/**
 * Per-schedule market selection — applies the priority + recency rules
 * from the product spec exactly once, in one place, so all UI surfaces
 * (predict panel on App.tsx, home-page live preview, troll-page list)
 * agree on which market is "the current one" for a given schedule.
 *
 * Selection rules:
 *   1. Group by scheduleType.
 *   2. Walk this status priority ladder:
 *        open > locked > settling > settled > voided
 *      The first non-empty bucket wins.  Lower-priority statuses are
 *      NEVER chosen when a higher-priority one exists for the slot.
 *   3. Within the chosen bucket, pick the row with the LATEST closeAt.
 */

const PANEL_SCHEDULES: ScheduleType[] = ["15m", "hourly", "daily"];

const STATUS_PRIORITY: Record<MarketSummary["status"], number> = {
  open: 0,
  locked: 1,
  settling: 2,
  settled: 3,
  voided: 4,
};

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
    if (new Date(m.closeAt).getTime() > new Date(best!.closeAt).getTime()) {
      best = m;
    }
  }
  return best;
}

/**
 * One slot per [15m, hourly, daily] in fixed order.  An entry's `market`
 * is null only when the API has zero rows for that schedule (cold start).
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
 * excluded so home-page "live markets" sections don't list stale rows.
 */
export function pickActivePanelMarkets(
  all: readonly MarketSummary[],
): MarketSummary[] {
  return PANEL_SCHEDULES.map((s) => pickMarketForSchedule(all, s)).filter(
    (m): m is MarketSummary => m != null && (m.status === "open" || m.status === "locked"),
  );
}
