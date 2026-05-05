import { db, type MarketRow } from "../db/supabase";
import { settleMarketViaWorker } from "./settlementOrchestrator";
import { ensureOneActivePerSchedule, listActiveBySchedule } from "./marketSeeder";
import type { ScheduleType } from "../../src/market/marketTypes";

/**
 * Production "tick" — single function that settles every expired market and
 * fills every empty schedule slot in one pass.  Designed to run on a 1-minute
 * cron (Render Cron Job, GitHub Actions, cron-job.org, ...) so the lifecycle
 * never stalls.
 *
 * Why a combined endpoint instead of three separate workers?
 *   The previous pattern split this work across three crons (seed / settle /
 *   payouts).  In production, exactly one of those (the seed cron) ended up
 *   not running on Render — leaving every slot stuck "locked" once close_at
 *   passed and no replacement was created.  Bundling settle + seed into one
 *   atomic-from-the-operator's-perspective call removes that failure mode:
 *   if the cron runs at all, the lifecycle advances.
 *
 * Operational behavior:
 *   1. Find every market with status ∈ {open, locked, settling} AND close_at
 *      < now.  Each one is past its scheduled close.
 *   2. For each, call settleMarketViaWorker — which:
 *        - atomically claims the row (CAS open|locked → settling)
 *        - runs the brain's settleMarket (collects live $TROLL MC snapshots,
 *          resolves YES/NO/VOID, computes payouts)
 *        - persists settlement_mc, settlement_price_usd,
 *          settlement_snapshot_at, settlement_result, outcome
 *        - queues escrow_withdrawals for refunds/payouts
 *        - hands off to seedSingle() for that schedule_type
 *   3. After every settlement attempt, run ensureOneActivePerSchedule() as a
 *      belt-and-braces sweep: any schedule whose hand-off seedSingle failed
 *      (e.g., DexScreener flake) gets retried here, and any schedule that
 *      had no expired market but is also empty (cold-start) gets seeded.
 *   4. Read back the current active state per schedule_type and return it
 *      alongside the {settled, created} arrays.
 *
 * Idempotency:
 *   - settleMarketViaWorker uses an atomic CAS so concurrent ticks can't
 *     double-settle.  Losing-CAS calls return "already_in_flight_or_terminal"
 *     and are reported in `skipped`, not `errors`.
 *   - seedSingle uses the partial unique index `markets_one_active_per_
 *     schedule` so concurrent ticks can't double-seed.  Losing-race inserts
 *     return `{created: false, reason: "race_lost"}`.
 *   - Net effect: calling tickMarkets() twice in the same second is safe.
 *
 * Window-elapsed: NOT enforced here, by design (per spec).  The brain's
 * collectSnapshotsSynthetic polls live providers and tags the snapshots
 * with synthetic timestamps inside the close window, so a market that
 * closed 1ms ago can be settled immediately and still produce a valid
 * snapshot set.  This differs from the legacy `settle` worker which waits
 * for window/2 seconds past close_at before settling.
 */

export interface TickSettledEntry {
  marketId: string;
  scheduleType: ScheduleType;
  outcome: "YES" | "NO" | "VOID";
  voidReason: string | null;
  settlementMc: number | null;
  /** Set when the orchestrator's hand-off seedSingle created the replacement. */
  nextMarketId: string | null;
  /** Set when the hand-off was a no-op (e.g. another tick already created it). */
  nextSeedReason: string | null;
}

export interface TickSkippedEntry {
  marketId: string;
  reason: string;
}

export interface TickCreatedEntry {
  marketId: string;
  scheduleType: ScheduleType;
  openMc: number | null;
  openPriceUsd: number | null;
  openSnapshotSource: "dexscreener" | "geckoterminal" | "manual" | null;
  closeAt: string | null;
}

export interface TickActiveEntry {
  scheduleType: ScheduleType;
  /** null when the slot is genuinely empty (snapshot provider down, etc.). */
  marketId: string | null;
  status: string | null;
  closeAt: string | null;
  openMc: number | null;
}

export interface TickError {
  marketId: string;
  error: string;
}

export interface TickResult {
  /** Markets that became terminal in this tick. */
  settled: TickSettledEntry[];
  /** Markets created (either via post-settle hand-off OR via the trailing
   *  ensureOneActivePerSchedule sweep). */
  created: TickCreatedEntry[];
  /** The current active market for each schedule_type after the tick. */
  active: TickActiveEntry[];
  /** Markets that the tick chose not to settle this round (already in flight,
   *  already terminal, etc.) — informational, not an error. */
  skipped: TickSkippedEntry[];
  /** Hard errors per market — the tick continues past these. */
  errors: TickError[];
  /** Wall-clock duration. */
  elapsedMs: number;
}

const ALL_SCHEDULES: ScheduleType[] = ["15m", "hourly", "daily"];

export async function tickMarkets(): Promise<TickResult> {
  const startedAt = Date.now();
  const sb = db();
  const cutoff = new Date().toISOString();
  console.info(`[tick] BEGIN cutoff=${cutoff}`);

  // ----- 0) v19 product rule: do NOT pre-fetch a tick-wide snapshot. -----
  // Each post-settle handoff and each empty-slot seed must take its OWN
  // fresh snapshot at its own opening moment so 15m / hourly / daily get
  // independent open_mc / target_mc values.  The previous behavior — one
  // shared snapshot for the whole tick — produced identical targets across
  // schedules whenever the tick filled multiple slots in the same run
  // (cold start, post-outage backfill, missed-cron catch-up).
  //
  // Burst protection: in steady state a tick has at most one settle, so
  // this is at most one provider call per tick.  At cold start with 3
  // empty slots it's 3 sequential calls — well under DexScreener's 60
  // req/min limit.  Any individual fetch failure is caught downstream
  // (seedSingle returns { created: false, reason: <verbatim error> })
  // and surfaced into errors[] without breaking the rest of the tick.

  // 1) Find every market past close_at with non-terminal status.
  const { data: expired, error: queryErr } = await sb
    .from("markets")
    .select("id, schedule_type, status, close_at")
    .in("status", ["open", "locked", "settling"])
    .lt("close_at", cutoff)
    .returns<Pick<MarketRow, "id" | "schedule_type" | "status" | "close_at">[]>();
  if (queryErr) throw queryErr;

  console.info(`[tick] expired-found count=${(expired ?? []).length}`);

  // 2) Try to settle each one.
  const settled: TickSettledEntry[] = [];
  const skipped: TickSkippedEntry[] = [];
  const created: TickCreatedEntry[] = [];
  const errors: TickError[] = [];

  for (const m of expired ?? []) {
    try {
      console.info(`[tick] settling market=${m.id} schedule=${m.schedule_type} status=${m.status}`);
      // v19: no shared tick snapshot.  The settle worker's post-settle
      // handoff to seedSingle will fetch its own fresh snapshot at the
      // moment of the new market's opening (= now).
      const r = await settleMarketViaWorker(m.id);
      settled.push({
        marketId: r.marketId,
        scheduleType: m.schedule_type,
        outcome: r.outcome,
        voidReason: r.voidReason,
        settlementMc: r.canonicalMc,
        nextMarketId: r.nextMarketId,
        nextSeedReason: r.nextSeedReason,
      });
      // Capture the hand-off creation, if any.
      if (r.nextMarketId) {
        // Read back the new market for response detail.
        const { data: nextRow } = await sb
          .from("markets")
          .select("id, schedule_type, open_mc, open_price_usd, close_at")
          .eq("id", r.nextMarketId)
          .maybeSingle<{
            id: string;
            schedule_type: ScheduleType;
            open_mc: string | null;
            open_price_usd: string | null;
            close_at: string;
          }>();
        if (nextRow) {
          created.push({
            marketId: nextRow.id,
            scheduleType: nextRow.schedule_type,
            openMc: nextRow.open_mc != null ? Number.parseFloat(nextRow.open_mc) : null,
            openPriceUsd:
              nextRow.open_price_usd != null ? Number.parseFloat(nextRow.open_price_usd) : null,
            openSnapshotSource: null, // not persisted on the row
            closeAt: nextRow.close_at,
          });
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      // Benign races — another tick or the legacy settle worker beat us.
      if (
        msg === "settlement_already_in_flight_or_terminal" ||
        msg.startsWith("market_already_terminal")
      ) {
        skipped.push({ marketId: m.id, reason: msg });
      } else {
        console.error(`[tick] settle-error market=${m.id} reason=${msg}`);
        errors.push({ marketId: m.id, error: msg });
      }
    }
  }

  // 3) Belt-and-braces seed sweep.  Catches:
  //    - schedules that had NO expired market but ARE empty (cold-start)
  //    - schedules whose orchestrator hand-off failed (snapshot flake)
  //    - schedules whose handed-off market just settled in step 2 but
  //      seedSingle hadn't been called for them yet
  //
  // v19: each empty schedule fetches its OWN fresh snapshot inside
  // seedSingle.  We deliberately do NOT pass a shared snapshot here so
  // that 15m / hourly / daily end up with independent open_mc values.
  // Per-schedule failures come back in seedReport.results[i] as
  // { created: false, reason: <string> } and we surface non-benign
  // reasons into errors[].
  console.info(`[tick] sweep-seed`);
  const seedReport = await ensureOneActivePerSchedule();
  for (const r of seedReport.results) {
    if (r.created && r.marketId) {
      // Avoid double-counting hand-off creations.
      if (!created.some((c) => c.marketId === r.marketId)) {
        created.push({
          marketId: r.marketId,
          scheduleType: r.scheduleType,
          openMc: r.snapshot?.marketCapUsd ?? null,
          openPriceUsd: r.snapshot?.priceUsd ?? null,
          openSnapshotSource: r.snapshot?.source ?? null,
          closeAt: null, // seeder doesn't return closeAt; read below if needed
        });
      }
      continue;
    }
    // Non-creation outcome: classify as benign (skipped) or actionable (error).
    // Benign = the slot is fine without a new market this tick.
    // Actionable = the slot is EMPTY and we couldn't fill it; the operator
    // needs to know why.
    const reason = r.reason ?? "unknown";
    const isBenign =
      reason === "already_active" || // slot is already filled
      reason === "race_lost"; // a concurrent seeder won
    if (isBenign) {
      // Surface in skipped[] so the operator can still see what happened —
      // distinguishes "no work to do" from "work failed".  Use a synthetic
      // marketId since seedReport doesn't always carry one.
      skipped.push({
        marketId: r.marketId ?? `<${r.scheduleType}>`,
        reason,
      });
    } else {
      // ACTIONABLE: snapshot failed, or some other unexpected error.  Put
      // the verbatim reason in errors[] so the JSON response explains it.
      console.warn(`[tick] seed-error schedule=${r.scheduleType} reason=${reason}`);
      errors.push({
        marketId: `<${r.scheduleType}>`,
        error: reason,
      });
    }
  }

  // 4) Read current active state per schedule.  Even if create-failed (snapshot
  // provider down), the response shows null/empty so the caller can detect it.
  const activeMap = await listActiveBySchedule();
  const active: TickActiveEntry[] = ALL_SCHEDULES.map((s) => {
    const row = activeMap[s];
    return {
      scheduleType: s,
      marketId: row?.id ?? null,
      status: row?.status ?? null,
      closeAt: row?.close_at ?? null,
      openMc: row?.open_mc != null ? Number.parseFloat(row.open_mc) : null,
    };
  });

  // Backfill missing closeAt for any created entry that came in via the seed
  // sweep — listActiveBySchedule has the closeAt for the active row, which
  // *is* the just-created one.
  for (const c of created) {
    if (c.closeAt == null) {
      const a = active.find((x) => x.marketId === c.marketId);
      if (a) c.closeAt = a.closeAt;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.info(
    `[tick] DONE elapsedMs=${elapsedMs} settled=${settled.length} ` +
      `created=${created.length} skipped=${skipped.length} errors=${errors.length} ` +
      `active=${active.filter((a) => a.marketId).length}/3`,
  );

  return { settled, created, active, skipped, errors, elapsedMs };
}
