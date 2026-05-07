import { db, type MarketRow } from "../db/supabase";
import { fetchTrollSnapshot, fetchCoinSnapshot, type LiveSnapshot } from "./marketSnapshot";
import {
  createMarket,
  nextQuarterHour,
  nextTopOfHour,
  nextDailyClose,
} from "../../src/market/scheduler";
import { TROLL } from "../../src/config/troll";
import { COINS, DEFAULT_COIN } from "../../src/config/coins";
import type { CoinConfig, ScheduleType } from "../../src/market/marketTypes";

/**
 * Market lifecycle seeder.  Single source of truth for "is there exactly
 * one active market per (coin, schedule_type)?"
 *
 * v53 update: this is now per-coin.  Each registered coin gets its own
 * 3 schedules.  With 3 coins active, we maintain 9 active markets at all
 * times.
 *
 * Invariants:
 *   - At most one row per (coin_mint, schedule_type) with status ∈ open|locked|settling.
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
 *     given (coin, schedule) tuple already exists, it returns { created: false }.
 *   - The DB unique index means even if two cron processes race here, at
 *     most one INSERT succeeds — the other will get a constraint error
 *     which we map to { created: false, reason: 'race_lost' }.
 *
 * NOT covered here:
 *   - Settlement.  When a market settles, the orchestrator MUST call
 *     seedSingle(coin, schedule) immediately after persisting the terminal
 *     state, so the slot doesn't sit empty.
 */

const ALL_SCHEDULES: ScheduleType[] = ["15m", "hourly", "daily"];

export interface SeedSingleResult {
  scheduleType: ScheduleType;
  /** v53 — which coin this seed result applies to. */
  coinMint?: string;
  coinSymbol?: string;
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
function buildQuestion(
  symbol: string,
  scheduleType: ScheduleType,
  openMc: number,
  closeAt: Date,
): string {
  const mcLabel = formatMcShort(openMc);
  const sym = `$${symbol.toUpperCase()}`;
  switch (scheduleType) {
    case "15m":
      return `Will ${sym} MC be higher than ${mcLabel} when this 15-minute market closes?`;
    case "hourly": {
      const hour = closeAt.toLocaleTimeString("en-US", {
        hour: "numeric",
        timeZone: "America/New_York",
      });
      return `Will ${sym} MC be higher than ${mcLabel} at the ${hour} ET hourly close?`;
    }
    case "daily":
      return `Will ${sym} MC be higher than ${mcLabel} at the 7PM ET daily close?`;
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
  coin: CoinConfig,
  scheduleType: ScheduleType,
  preFetchedSnapshot?: LiveSnapshot,
): Promise<SeedSingleResult> {
  const sb = db();

  // Pre-flight check — cheap.  Filter on (coin_mint, schedule_type) so each
  // coin gets its own slot per schedule.
  const { data: existing, error: existingErr } = await sb
    .from("markets")
    .select("id, status, schedule_type, coin_mint")
    .eq("schedule_type", scheduleType)
    .eq("coin_mint", coin.mintAddress)
    .in("status", ["open", "locked", "settling"])
    .limit(1)
    .maybeSingle<{ id: string; status: string; schedule_type: string; coin_mint: string }>();
  if (existingErr) throw existingErr;
  if (existing) {
    console.info(
      `[seed] noop coin=${coin.symbol} schedule=${scheduleType} existing=${existing.id} status=${existing.status}`,
    );
    return {
      scheduleType,
      coinMint: coin.mintAddress,
      coinSymbol: coin.symbol,
      created: false,
      reason: "already_active",
      marketId: existing.id,
    };
  }

  // Use the caller-supplied snapshot when available, otherwise fetch.
  let snapshot: LiveSnapshot;
  if (preFetchedSnapshot) {
    snapshot = preFetchedSnapshot;
    console.info(
      `[seed] using-prefetched coin=${coin.symbol} schedule=${scheduleType} source=${snapshot.source} ` +
        `fromCache=${snapshot.fromCache} ageMs=${snapshot.ageMs}`,
    );
  } else {
    console.info(`[seed] snapshotting coin=${coin.symbol} schedule=${scheduleType}`);
    try {
      snapshot = await fetchCoinSnapshot(coin);
    } catch (err) {
      const msg = (err as Error).message;
      console.warn(
        `[seed] snapshot-failed coin=${coin.symbol} schedule=${scheduleType} reason=${msg}`,
      );
      return {
        scheduleType,
        coinMint: coin.mintAddress,
        coinSymbol: coin.symbol,
        created: false,
        reason: msg,
      };
    }
  }
  console.info(
    `[seed] snapshot coin=${coin.symbol} schedule=${scheduleType} ` +
      `mc=$${(snapshot.marketCapUsd / 1e6).toFixed(2)}M ` +
      `price=$${snapshot.priceUsd.toFixed(8)} source=${snapshot.source} ` +
      `fromCache=${snapshot.fromCache}`,
  );

  // Build the in-memory market via the existing brain helper, then override
  // the question with our higher/lower wording.
  const now = new Date();
  const closeAt = computeCloseAt(scheduleType, now);
  const market = createMarket({
    symbol: coin.symbol,
    scheduleType,
    closeAt,
    targetMc: snapshot.marketCapUsd,
    now,
  });
  market.question = buildQuestion(coin.symbol, scheduleType, snapshot.marketCapUsd, closeAt);

  // Insert.  The partial unique index `markets_one_active_per_coin_schedule`
  // is our last line of defense if two seeders raced past the pre-flight check.
  const { error: insertErr } = await sb.from("markets").insert({
    id: market.id,
    symbol: coin.symbol,
    coin_mint: coin.mintAddress,
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
    open_price_usd: snapshot.priceUsd.toString(),
    open_mc: snapshot.marketCapUsd.toString(),
    open_snapshot_at: snapshot.fetchedAt.toISOString(),
    market_kind: "higher_lower",
  });

  if (insertErr) {
    if (
      (insertErr as { code?: string }).code === "23505" ||
      /duplicate|unique/i.test((insertErr as Error).message)
    ) {
      const { data: winner } = await sb
        .from("markets")
        .select("id, status")
        .eq("schedule_type", scheduleType)
        .eq("coin_mint", coin.mintAddress)
        .in("status", ["open", "locked", "settling"])
        .limit(1)
        .maybeSingle<{ id: string; status: string }>();
      if (winner) {
        console.info(
          `[seed] race-resolved coin=${coin.symbol} schedule=${scheduleType} winner=${winner.id} status=${winner.status}`,
        );
        return {
          scheduleType,
          coinMint: coin.mintAddress,
          coinSymbol: coin.symbol,
          created: false,
          reason: "already_active",
          marketId: winner.id,
        };
      }
      console.warn(
        `[seed] race-lost coin=${coin.symbol} schedule=${scheduleType} (no winner found)`,
      );
      return {
        scheduleType,
        coinMint: coin.mintAddress,
        coinSymbol: coin.symbol,
        created: false,
        reason: "race_lost",
      };
    }
    console.error(
      `[seed] insert-failed coin=${coin.symbol} schedule=${scheduleType} error=${(insertErr as Error).message}`,
    );
    throw insertErr;
  }

  console.info(
    `[seed] CREATED coin=${coin.symbol} schedule=${scheduleType} id=${market.id} ` +
      `closeAt=${market.closeAt.toISOString()} openMc=$${(snapshot.marketCapUsd / 1e6).toFixed(2)}M`,
  );
  return {
    scheduleType,
    coinMint: coin.mintAddress,
    coinSymbol: coin.symbol,
    created: true,
    marketId: market.id,
    snapshot,
  };
}

/**
 * v53 — Walk every (active coin, schedule_type) tuple and seed any empty slot.
 *
 * With the multi-coin registry in place this maintains 3 schedules × N coins
 * markets (currently 9 with TROLL, USDUC, BUTT all active).
 *
 * Snapshot strategy:
 *   Each (coin, schedule) tuple gets its own fresh snapshot at its own
 *   opening moment.  No cross-coin snapshot reuse (coins have different MCs).
 *
 *   The sequential seeding does mean a cold-start where all 9 slots are
 *   empty triggers up to 9 provider calls.  With 3 coins × 3 schedules and
 *   DexScreener's 60 req/min rate limit, that's still well within budget.
 *
 * Manual emergency override:
 *   `preBuiltSnapshot` is only respected for the legacy single-coin TROLL
 *   path.  When supplied, all empty TROLL schedules share it, but other
 *   coins still fetch fresh snapshots.  This preserves the original admin
 *   "/seed-markets-from-manual-snapshot" recovery semantics while not
 *   breaking multi-coin: an operator pushing a manual TROLL snapshot
 *   shouldn't accidentally mis-tag USDUC or BUTT markets.
 */
export async function ensureOneActivePerSchedule(
  preBuiltSnapshot?: LiveSnapshot,
): Promise<{ results: SeedSingleResult[] }> {
  const sb = db();

  // 1) Determine which (coin, schedule) pairs need creation.
  const { data: activeRows, error: activeErr } = await sb
    .from("markets")
    .select("id, schedule_type, status, coin_mint")
    .in("status", ["open", "locked", "settling"])
    .returns<
      { id: string; schedule_type: ScheduleType; status: string; coin_mint: string }[]
    >();
  if (activeErr) throw activeErr;

  // Key: `${coin_mint}|${schedule}`.  Lets us check "is the (TROLL, 15m) slot
  // active?" in O(1) below.
  const activeMap = new Map<string, { id: string; status: string }>();
  for (const r of activeRows ?? []) {
    activeMap.set(`${r.coin_mint}|${r.schedule_type}`, { id: r.id, status: r.status });
  }

  const activeCoins = COINS.filter((c) => c.active);
  const totalSlots = activeCoins.length * ALL_SCHEDULES.length;
  const filledSlots = activeCoins.reduce((acc, c) => {
    return acc + ALL_SCHEDULES.filter((s) => activeMap.has(`${c.mintAddress}|${s}`)).length;
  }, 0);
  const needsFill = totalSlots - filledSlots;

  if (needsFill === 0) {
    console.info(
      `[seed] ensure-noop all-${totalSlots}-active across ${activeCoins.length} coins`,
    );
    const results: SeedSingleResult[] = [];
    for (const coin of activeCoins) {
      for (const sched of ALL_SCHEDULES) {
        const active = activeMap.get(`${coin.mintAddress}|${sched}`)!;
        results.push({
          scheduleType: sched,
          coinMint: coin.mintAddress,
          coinSymbol: coin.symbol,
          created: false,
          reason: "already_active",
          marketId: active.id,
        });
      }
    }
    return { results };
  }

  console.info(
    `[seed] ensure needsFill=${needsFill}/${totalSlots} ` +
      `coins=${activeCoins.map((c) => c.symbol).join(",")} ` +
      `mode=${preBuiltSnapshot ? "manual-override (TROLL only)" : "auto (per-coin per-schedule fresh)"}`,
  );

  // 2) Walk every (coin, schedule) tuple.  Already-active → no-op.
  const results: SeedSingleResult[] = [];
  for (const coin of activeCoins) {
    for (const sched of ALL_SCHEDULES) {
      const active = activeMap.get(`${coin.mintAddress}|${sched}`);
      if (active) {
        results.push({
          scheduleType: sched,
          coinMint: coin.mintAddress,
          coinSymbol: coin.symbol,
          created: false,
          reason: "already_active",
          marketId: active.id,
        });
        continue;
      }
      try {
        // Manual override only applies to TROLL — protects multi-coin
        // semantics (don't tag USDUC markets with a TROLL snapshot).
        const overrideSnap =
          coin.symbol === "TROLL" ? preBuiltSnapshot : undefined;
        results.push(await seedSingle(coin, sched, overrideSnap));
      } catch (err) {
        results.push({
          scheduleType: sched,
          coinMint: coin.mintAddress,
          coinSymbol: coin.symbol,
          created: false,
          reason: `error: ${(err as Error).message}`,
        });
      }
    }
  }
  return { results };
}

/**
 * Returns the currently-active market row per schedule type (or null when a
 * slot is empty).  Used by the admin overview / debugging.
 */
/**
 * Returns the currently-active market row per schedule for the DEFAULT coin
 * (TROLL).  Pre-v53 callers continue to work without change.
 *
 * For per-coin views, use listActiveByCoinSchedule().
 */
export async function listActiveBySchedule(): Promise<Record<ScheduleType, MarketRow | null>> {
  const sb = db();
  const { data, error } = await sb
    .from("markets")
    .select("*")
    .eq("coin_mint", DEFAULT_COIN.mintAddress)
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

/**
 * v53 — Returns the currently-active market rows grouped by (coin_mint, schedule).
 * Map shape: outer key = coin_mint, inner key = schedule_type.
 */
export async function listActiveByCoinSchedule(): Promise<
  Map<string, Record<ScheduleType, MarketRow | null>>
> {
  const sb = db();
  const { data, error } = await sb
    .from("markets")
    .select("*")
    .in("status", ["open", "locked", "settling"])
    .returns<MarketRow[]>();
  if (error) throw error;
  const out = new Map<string, Record<ScheduleType, MarketRow | null>>();
  for (const coin of COINS) {
    out.set(coin.mintAddress, { "15m": null, hourly: null, daily: null });
  }
  for (const row of data ?? []) {
    let coinMap = out.get(row.coin_mint);
    if (!coinMap) {
      // Unknown coin in DB (registry might not have it) — still surface it.
      coinMap = { "15m": null, hourly: null, daily: null };
      out.set(row.coin_mint, coinMap);
    }
    coinMap[row.schedule_type] = row;
  }
  return out;
}
