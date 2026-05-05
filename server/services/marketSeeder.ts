import { db, type MarketRow } from "../db/supabase";
import { fetchTrollSnapshot, type LiveSnapshot } from "./marketSnapshot";
import {
  createMarket,
  nextQuarterHour,
  nextTopOfHour,
  nextDailyClose,
} from "../../src/market/scheduler";
import { TROLL } from "../../src/config/troll";
import type { ScheduleType } from "../../src/market/marketTypes";

/**
 * Market lifecycle seeder.  Single source of truth for "is there exactly
 * one active market per schedule_type?"
 *
 * Invariants:
 *   - At most one row per schedule_type with status ∈ open|locked|settling.
 *     Enforced in code here AND by the partial unique index in schema.sql.
 *   - Every freshly-created market gets an opening snapshot taken from
 *     DexScreener (fallback GeckoTerminal) at insert time.  open_mc is the
 *     threshold the question asks about — "higher than this MC at close?"
 *   - target_mc is also set to open_mc so the existing brain settle code,
 *     which compares settlement_mc against market.targetMc, keeps working
 *     unchanged.
 *
 * Idempotency:
 *   - seedSingle is safe to call repeatedly.  If an active market for the
 *     given schedule already exists, it returns { created: false }.
 *   - The DB unique index means even if two cron processes race here, at
 *     most one INSERT succeeds — the other will get a constraint error
 *     which we map to { created: false, reason: 'race_lost' }.
 *
 * NOT covered here:
 *   - Settlement.  When a market settles, the orchestrator MUST call
 *     seedSingle(market.scheduleType) immediately after persisting the
 *     terminal state, so the slot doesn't sit empty.  A safety-net cron
 *     (npm run seed:markets) will also re-seed any empty slot, but only on
 *     its next tick, so the orchestrator handoff is what keeps the gap
 *     short in normal operation.
 */

const ALL_SCHEDULES: ScheduleType[] = ["15m", "hourly", "daily"];

export interface SeedSingleResult {
  scheduleType: ScheduleType;
  created: boolean;
  marketId?: string;
  /** Reason this seed attempt was a no-op (e.g., 'already_active', 'race_lost'). */
  reason?: string;
  /** Snapshot used for the opening MC — only present when created=true. */
  snapshot?: LiveSnapshot;
}

/**
 * Compute closeAt for a fresh market of this schedule, given the current time.
 *
 *   - 15m    : next :00 / :15 / :30 / :45 boundary
 *   - hourly : next top-of-hour
 *   - daily  : next 19:00 America/New_York
 *
 * If the next boundary is "too soon" (< 5 seconds away) we hop to the one
 * after, so the freshly-created market doesn't lock essentially-immediately.
 * This matters most for 15m at boundary edges.
 */
function computeCloseAt(scheduleType: ScheduleType, now: Date): Date {
  const SOON_MS = 5_000;
  let candidate: Date;
  switch (scheduleType) {
    case "15m":
      candidate = nextQuarterHour(now);
      if (candidate.getTime() - now.getTime() < SOON_MS) {
        candidate = nextQuarterHour(new Date(candidate.getTime() + 60_000));
      }
      return candidate;
    case "hourly":
      candidate = nextTopOfHour(now);
      if (candidate.getTime() - now.getTime() < SOON_MS) {
        candidate = nextTopOfHour(new Date(candidate.getTime() + 60_000));
      }
      return candidate;
    case "daily":
      return nextDailyClose(now);
  }
}

/**
 * Generate the higher/lower question for a freshly-snapshot-ed market.
 *
 * Examples:
 *   "Will $TROLL MC be higher than $42.5M when this 15-minute market closes?"
 *   "Will $TROLL MC be higher than $1.2B at the 7PM ET daily close?"
 */
function buildQuestion(scheduleType: ScheduleType, openMc: number, closeAt: Date): string {
  const mcLabel = formatMcShort(openMc);
  switch (scheduleType) {
    case "15m":
      return `Will $TROLL MC be higher than ${mcLabel} when this 15-minute market closes?`;
    case "hourly": {
      const hour = closeAt.toLocaleTimeString("en-US", {
        hour: "numeric",
        timeZone: "America/New_York",
      });
      return `Will $TROLL MC be higher than ${mcLabel} at the ${hour} ET hourly close?`;
    }
    case "daily":
      return `Will $TROLL MC be higher than ${mcLabel} at the 7PM ET daily close?`;
  }
}

function formatMcShort(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Seed exactly one market for a single schedule_type, if and only if the
 * slot is empty.
 *
 * Race-safe: relies on the partial unique index `markets_one_active_per_schedule`
 * to make the INSERT fail if another process already created one.
 */
export async function seedSingle(
  scheduleType: ScheduleType,
  preFetchedSnapshot?: LiveSnapshot,
): Promise<SeedSingleResult> {
  const sb = db();

  // Pre-flight check — cheap.
  const { data: existing, error: existingErr } = await sb
    .from("markets")
    .select("id, status, schedule_type")
    .eq("schedule_type", scheduleType)
    .in("status", ["open", "locked", "settling"])
    .limit(1)
    .maybeSingle<{ id: string; status: string; schedule_type: string }>();
  if (existingErr) throw existingErr;
  if (existing) {
    console.info(
      `[seed] noop schedule=${scheduleType} existing=${existing.id} status=${existing.status}`,
    );
    return { scheduleType, created: false, reason: "already_active", marketId: existing.id };
  }

  // Use the caller-supplied snapshot when available, otherwise fetch.
  // The tick endpoint passes one snapshot to all 3 schedules in a single
  // tick so we hit DexScreener once per cron, not once per schedule.
  let snapshot: LiveSnapshot;
  if (preFetchedSnapshot) {
    snapshot = preFetchedSnapshot;
    console.info(
      `[seed] using-prefetched schedule=${scheduleType} source=${snapshot.source} ` +
        `fromCache=${snapshot.fromCache} ageMs=${snapshot.ageMs}`,
    );
  } else {
    console.info(`[seed] snapshotting schedule=${scheduleType}`);
    try {
      snapshot = await fetchTrollSnapshot();
    } catch (err) {
      const msg = (err as Error).message;
      console.warn(`[seed] snapshot-failed schedule=${scheduleType} reason=${msg}`);
      // Surface the snapshot error VERBATIM so the tick endpoint can put it
      // in errors[] without further wrapping — the operator sees exactly
      // what failed (e.g. "snapshot_unavailable_no_fresh_cache: ...").
      return {
        scheduleType,
        created: false,
        reason: msg,
      };
    }
  }
  console.info(
    `[seed] snapshot schedule=${scheduleType} mc=$${(snapshot.marketCapUsd / 1e6).toFixed(2)}M ` +
      `price=$${snapshot.priceUsd.toFixed(8)} source=${snapshot.source} ` +
      `fromCache=${snapshot.fromCache}`,
  );

  // Build the in-memory market via the existing brain helper, then override
  // the question with our higher/lower wording.
  const now = new Date();
  const closeAt = computeCloseAt(scheduleType, now);
  const market = createMarket({
    symbol: TROLL.symbol,
    scheduleType,
    closeAt,
    targetMc: snapshot.marketCapUsd, // = open_mc; brain compares settlement_mc against this
    now,
  });
  market.question = buildQuestion(scheduleType, snapshot.marketCapUsd, closeAt);

  // Insert.  The partial unique index `markets_one_active_per_schedule` is
  // our last line of defense if two seeders raced past the pre-flight check.
  const { error: insertErr } = await sb.from("markets").insert({
    id: market.id,
    symbol: market.symbol,
    question: market.question,
    schedule_type: market.scheduleType,
    target_mc: market.targetMc.toString(),
    close_at: market.closeAt.toISOString(),
    lock_at: market.lockAt.toISOString(),
    window_seconds: market.windowSeconds,
    poll_cadence_seconds: market.pollCadenceSeconds,
    status: market.status,
    amm_b: market.amm.b.toString(),
    amm_q_yes: "0",
    amm_q_no: "0",
    yes_price_cents: "50",
    no_price_cents: "50",
    created_by: "seeder",
    // Lifecycle columns — opening snapshot.
    open_price_usd: snapshot.priceUsd.toString(),
    open_mc: snapshot.marketCapUsd.toString(),
    open_snapshot_at: snapshot.fetchedAt.toISOString(),
    market_kind: "higher_lower",
  });

  if (insertErr) {
    // Postgres unique violation has SQLSTATE 23505; Supabase REST surfaces it
    // as `code: '23505'` in the error object.
    if (
      (insertErr as { code?: string }).code === "23505" ||
      /duplicate|unique/i.test((insertErr as Error).message)
    ) {
      console.warn(`[seed] race-lost schedule=${scheduleType}`);
      return { scheduleType, created: false, reason: "race_lost" };
    }
    console.error(
      `[seed] insert-failed schedule=${scheduleType} error=${(insertErr as Error).message}`,
    );
    throw insertErr;
  }

  console.info(
    `[seed] CREATED schedule=${scheduleType} id=${market.id} ` +
      `closeAt=${market.closeAt.toISOString()} openMc=$${(snapshot.marketCapUsd / 1e6).toFixed(2)}M`,
  );
  return { scheduleType, created: true, marketId: market.id, snapshot };
}

/**
 * Walk all 3 schedule types and seed any empty slot.
 *
 * Snapshot strategy:
 *   - First, list which schedules are currently empty (one cheap query).
 *   - If none are empty → return early without hitting any snapshot provider.
 *   - If some are empty → fetch ONE snapshot and pass it to every seedSingle
 *     call.  This keeps the per-tick provider hit count to 1 instead of 3,
 *     which is what causes the 429 cascade in production.
 *
 * The optional `preBuiltSnapshot` parameter lets the manual-snapshot admin
 * endpoint inject an operator-supplied value, bypassing live fetches
 * entirely — useful when DexScreener / GeckoTerminal are both unhappy and
 * the operator just wants to unstick the lifecycle.
 *
 * Returns a structured summary.  Per-schedule failures (snapshot unavailable,
 * race lost, etc.) are reflected in `results[].reason` — the tick endpoint
 * inspects these to populate `errors[]` in its JSON response.
 */
export async function ensureOneActivePerSchedule(
  preBuiltSnapshot?: LiveSnapshot,
): Promise<{ results: SeedSingleResult[] }> {
  const sb = db();

  // 1) Determine which schedules need creation.
  const { data: activeRows, error: activeErr } = await sb
    .from("markets")
    .select("id, schedule_type, status")
    .in("status", ["open", "locked", "settling"])
    .returns<{ id: string; schedule_type: ScheduleType; status: string }[]>();
  if (activeErr) throw activeErr;
  const activeBySched = new Map<ScheduleType, { id: string; status: string }>();
  for (const r of activeRows ?? []) {
    activeBySched.set(r.schedule_type, { id: r.id, status: r.status });
  }
  const needsFill = ALL_SCHEDULES.filter((s) => !activeBySched.has(s));

  // 2) Short-circuit when nothing needs filling.
  if (needsFill.length === 0) {
    console.info(`[seed] ensure-noop all-3-active`);
    return {
      results: ALL_SCHEDULES.map((s) => ({
        scheduleType: s,
        created: false,
        reason: "already_active",
        marketId: activeBySched.get(s)!.id,
      })),
    };
  }

  // 3) Acquire the snapshot ONCE for all needed creates.
  let snapshot: LiveSnapshot | null = preBuiltSnapshot ?? null;
  let snapshotError: string | null = null;
  if (!snapshot) {
    console.info(`[seed] ensure-fetching needsFill=${needsFill.join(",")}`);
    try {
      snapshot = await fetchTrollSnapshot();
    } catch (err) {
      snapshotError = (err as Error).message;
      console.warn(`[seed] ensure-snapshot-failed reason=${snapshotError}`);
    }
  }

  // 4) Walk all 3 schedules, building a per-schedule result.  Already-active
  // schedules return immediately; empty schedules either get the snapshot
  // (and a real seed attempt) or get the snapshot error verbatim as their
  // reason — so the tick endpoint can put it in errors[].
  const results: SeedSingleResult[] = [];
  for (const sched of ALL_SCHEDULES) {
    const active = activeBySched.get(sched);
    if (active) {
      results.push({
        scheduleType: sched,
        created: false,
        reason: "already_active",
        marketId: active.id,
      });
      continue;
    }
    if (snapshot) {
      try {
        results.push(await seedSingle(sched, snapshot));
      } catch (err) {
        results.push({
          scheduleType: sched,
          created: false,
          reason: `error: ${(err as Error).message}`,
        });
      }
    } else {
      results.push({
        scheduleType: sched,
        created: false,
        // snapshotError is the verbatim error string from fetchTrollSnapshot —
        // e.g. "snapshot_unavailable_no_fresh_cache: dexscreener: dexscreener_429
        // | geckoterminal: geckoterminal_429 | cache: missing".
        reason: snapshotError ?? "snapshot_unavailable",
      });
    }
  }
  return { results };
}

/**
 * Returns the currently-active market row per schedule type (or null when a
 * slot is empty).  Used by the admin overview / debugging.
 */
export async function listActiveBySchedule(): Promise<Record<ScheduleType, MarketRow | null>> {
  const sb = db();
  const { data, error } = await sb
    .from("markets")
    .select("*")
    .in("status", ["open", "locked", "settling"])
    .returns<MarketRow[]>();
  if (error) throw error;
  const out: Record<ScheduleType, MarketRow | null> = {
    "15m": null,
    hourly: null,
    daily: null,
  };
  for (const row of data ?? []) {
    out[row.schedule_type] = row;
  }
  return out;
}
