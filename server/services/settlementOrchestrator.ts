import { db, type MarketRow, type PositionRow, type TradeRow } from "../db/supabase";
import { assembleMarket } from "../db/marketLoader";
import { settleMarket } from "../../src/market/settlementEngine";
import { TROLL } from "../../src/config/troll";
import { findCoinByMint, DEFAULT_COIN } from "../../src/config/coins";
import { DexScreenerProvider } from "../../src/providers/dexScreenerProvider";
import { GeckoTerminalProvider } from "../../src/providers/geckoTerminalProvider";
import { CachedBrainProvider } from "./cachedBrainProvider";
import type { User } from "../../src/market/marketTypes";
import { seedSingle } from "./marketSeeder";
import { runPendingWithdrawals } from "./payoutEngine";
import type { LiveSnapshot } from "./marketSnapshot";

/**
 * Server-side settlement.
 *
 *   1. Atomically claim the slot: UPDATE markets SET status='settling', version=version+1
 *      WHERE id=? AND status IN ('open','locked') AND version=expected.
 *      If no row updated → another worker is already settling, or the market is terminal.
 *   2. Reconstruct the user list from positions
 *   3. Run brain `settleMarket` (polls oracles, resolves, applies payouts)
 *   4. Persist: market terminal state, position terminal states, snapshots,
 *      audit_receipts, settlements
 *   5. Queue escrow_withdrawals for every winner / refundee
 *
 * AUDIT FIX: previously the worker only checked `status==='settled'||'voided'`
 * before running.  Two concurrent workers could both pass that check, both run
 * the brain settlement, and both queue duplicate withdrawals — double payout.
 *
 * The atomic claim in step 1 fixes this: only one worker can transition the
 * market into 'settling', the rest see "already_in_flight_or_terminal".
 */
export async function settleMarketViaWorker(
  marketId: string,
  preFetchedSnapshot?: LiveSnapshot,
): Promise<{
  marketId: string;
  outcome: "YES" | "NO" | "VOID";
  voidReason: string | null;
  canonicalMc: number | null;
  userSettlements: number;
  withdrawalsQueued: number;
  /** ID of the freshly-seeded next market for the same schedule, or null. */
  nextMarketId: string | null;
  /** Reason the post-settle seed was a no-op (e.g. 'already_active'). */
  nextSeedReason: string | null;
}> {
  const sb = db();

  // 1) Read current market row to learn its version and validate status
  const { data: marketRow, error: mErr } = await sb
    .from("markets")
    .select("*")
    .eq("id", marketId)
    .maybeSingle<MarketRow>();
  if (mErr) throw mErr;
  if (!marketRow) throw new Error(`market_not_found: ${marketId}`);
  if (marketRow.status === "settled" || marketRow.status === "voided") {
    throw new Error(`market_already_terminal: ${marketRow.status}`);
  }
  console.info(
    `[settle] BEGIN market=${marketId} status=${marketRow.status} ` +
      `schedule=${marketRow.schedule_type} version=${marketRow.version}`,
  );
  if (marketRow.status === "settling") {
    // Could be a previous run that crashed; we still try to claim it via version
    // check so a manual re-run can resume.  If the version moved, we bail.
  }

  // 1a) Claim — atomic CAS on (id, version, status ∈ open|locked|settling)
  const claimVersion = marketRow.version + 1;
  const { data: claimed, error: claimErr } = await sb
    .from("markets")
    .update({ status: "settling", version: claimVersion })
    .eq("id", marketId)
    .eq("version", marketRow.version)
    .in("status", ["open", "locked", "settling"])
    .select("version")
    .maybeSingle<{ version: number }>();
  if (claimErr) throw claimErr;
  if (!claimed) {
    throw new Error("settlement_already_in_flight_or_terminal");
  }

  // 2) Load positions/trades and assemble in-memory market
  const { data: posRows } = await sb
    .from("positions")
    .select("*")
    .eq("market_id", marketId)
    .returns<PositionRow[]>();
  const { data: tradeRows } = await sb
    .from("trades")
    .select("*")
    .eq("market_id", marketId)
    .returns<TradeRow[]>();
  const market = assembleMarket(
    { ...marketRow, status: "settling", version: claimVersion },
    posRows ?? [],
    tradeRows ?? [],
  );

  // 3) Build user stubs and run brain settlement with REAL oracle providers
  const wallets = new Set(market.positions.map((p) => p.wallet));
  const users: User[] = Array.from(wallets).map((w) => ({ wallet: w, trollBalance: 0 }));

  // v53 — look up the coin this market is for so settlement uses the
  // correct mint, dexscreener URLs, and liquidity / volume floors.  Falls
  // back to DEFAULT_COIN (TROLL) for legacy rows missing coin_mint.
  const settlementCoin =
    findCoinByMint(marketRow.coin_mint) ?? DEFAULT_COIN;

  // Settlement-time providers — wrapped with CachedBrainProvider so the
  // brain's per-timestamp polling falls back to oracle_snapshots when
  // DexScreener / GeckoTerminal 429.  This is the same cache the tick
  // endpoint populates; settlement and seeding share one freshness window.
  // When BOTH live and cache fail, the wrapper returns the live error
  // verbatim and the brain voids with a clear reason.
  const providers = [
    new CachedBrainProvider(new DexScreenerProvider()),
    new CachedBrainProvider(new GeckoTerminalProvider()),
  ];
  console.info(
    `[settle] running-brain market=${marketId} coin=${settlementCoin.symbol} ` +
      `positions=${market.positions.length} users=${users.length}`,
  );
  const receipt = await settleMarket({
    market,
    coin: settlementCoin,
    providers,
    users,
  });
  console.info(
    `[settle] brain-result market=${marketId} outcome=${receipt.outcome} ` +
      `voidReason=${receipt.voidReason ?? "n/a"} canonicalMc=${receipt.canonicalMc ?? "n/a"} ` +
      `userSettlements=${receipt.userSettlements.length} snapshots=${(receipt.snapshots ?? []).length}`,
  );

  // Compute settlement_price_usd from in-window snapshot prices.  We just
  // average the priceUsd field across snapshots that succeeded — the brain
  // already filtered to in-window for MC, and snapshots that ok=true also
  // expose priceUsd alongside marketCapUsd.
  const validPrices = (receipt.snapshots ?? [])
    .filter((s) => s.ok && typeof s.priceUsd === "number" && (s.priceUsd as number) > 0)
    .map((s) => s.priceUsd as number);
  const settlementPriceUsd =
    validPrices.length > 0
      ? validPrices.reduce((acc, x) => acc + x, 0) / validPrices.length
      : null;
  const settledAtIso = new Date().toISOString();

  // 4a) Persist market terminal state — bump version again.
  // We write BOTH the legacy columns (`outcome`, `settlement_mc`) AND the new
  // higher/lower lifecycle columns (`settlement_result`, `settlement_price_usd`,
  // `settlement_snapshot_at`).  Existing audit code reads the legacy columns;
  // the new columns let analytics query "open vs settled MC" directly.
  await sb
    .from("markets")
    .update({
      status: market.status,
      yes_price_cents: market.yesPriceCents.toString(),
      no_price_cents: market.noPriceCents.toString(),
      settlement_mc: market.settlementMc?.toString() ?? null,
      outcome: market.outcome,
      void_reason: market.voidReason,
      settled_at: settledAtIso,
      version: claimVersion + 1,
      // New lifecycle columns
      settlement_result: market.outcome,
      settlement_price_usd: settlementPriceUsd != null ? settlementPriceUsd.toString() : null,
      settlement_snapshot_at: settledAtIso,
    })
    .eq("id", marketId);

  // 4b) Persist position terminal states
  for (const p of market.positions) {
    await sb
      .from("positions")
      .update({
        status: p.status,
        shares: p.shares.toString(),
        cost_basis_troll: p.costBasisTroll.toString(),
        realized_pnl_troll: p.realizedPnlTroll.toString(),
        average_entry_price_cents: p.averageEntryPriceCents.toString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", p.id);
  }

  // 4c) Persist snapshots
  for (const snap of receipt.snapshots ?? []) {
    await sb.from("market_snapshots").insert({
      market_id: marketId,
      source: snap.source,
      fetched_at: snap.fetchedAt instanceof Date ? snap.fetchedAt.toISOString() : new Date(snap.fetchedAt).toISOString(),
      market_cap_usd: snap.marketCapUsd?.toString() ?? null,
      price_usd: snap.priceUsd?.toString() ?? null,
      liquidity_usd: snap.liquidityUsd?.toString() ?? null,
      volume_24h_usd: snap.volume24hUsd?.toString() ?? null,
      ok: snap.ok,
      error_text: snap.errorText,
      raw_payload: snap.rawPayload ?? null,
    });
  }

  // 4d) Persist audit receipt (upsert — re-runnable)
  await sb.from("audit_receipts").upsert(
    {
      market_id: marketId,
      question: market.question,
      target_mc: market.targetMc.toString(),
      close_at: market.closeAt.toISOString(),
      schedule_type: market.scheduleType,
      source_medians: receipt.perSourceMedian ?? {},
      canonical_mc: market.settlementMc?.toString() ?? null,
      outcome: market.outcome ?? "VOID",
      void_reason: market.voidReason,
      final_yes_price_cents: market.yesPriceCents.toString(),
      final_no_price_cents: market.noPriceCents.toString(),
      user_settlements: receipt.userSettlements ?? [],
      snapshot_bundle: receipt.snapshots ?? [],
      snapshot_bundle_hash: receipt.snapshotBundleHash,
    },
    { onConflict: "market_id" },
  );

  // 4e) Persist settlement row (upsert — re-runnable)
  await sb.from("settlements").upsert(
    {
      market_id: marketId,
      outcome: market.outcome ?? "VOID",
      void_reason: market.voidReason,
      canonical_mc: market.settlementMc?.toString() ?? null,
      source_medians: receipt.perSourceMedian ?? {},
      snapshot_count: (receipt.snapshots ?? []).length,
    },
    { onConflict: "market_id" },
  );

  // 5) Queue escrow_withdrawals.
  // Idempotency: each (market_id, position_id, reason) is uniquely the result of
  // settlement.  Because we claimed the slot in step 1, we are the only worker
  // running this market.  Re-runs (after a crash) re-enter via the version check
  // and produce identical user_settlements, so duplicates would be additive.
  // We dedupe by checking for existing payout/refund rows on this market first.
  const { data: existingWithdrawals } = await sb
    .from("escrow_withdrawals")
    .select("position_id, reason")
    .eq("market_id", marketId)
    .in("reason", ["payout", "refund"]);
  const alreadyQueued = new Set(
    (existingWithdrawals ?? []).map((w) => `${w.reason}:${w.position_id ?? ""}`),
  );

  let withdrawalsQueued = 0;
  for (const us of receipt.userSettlements ?? []) {
    const payout = us.payoutTroll ?? 0;
    if (payout <= 0) continue;
    const reason = us.finalStatus === "void_refunded" ? "refund" : "payout";
    const dedupeKey = `${reason}:${us.positionId ?? ""}`;
    if (alreadyQueued.has(dedupeKey)) continue;
    const { error } = await sb.from("escrow_withdrawals").insert({
      market_id: marketId,
      wallet: us.wallet,
      amount_troll: payout.toString(),
      // v23: every payout is SOL.  The brain's `amount_troll` column is
      // overloaded here — for v23 markets it carries the SOL-equivalent
      // pinned at entry time, NOT a TROLL token amount.  The payout
      // engine reads currency='sol' and dispatches to SystemProgram.transfer.
      currency: "sol",
      reason,
      status: "pending",
      position_id: us.positionId ?? null,
    });
    if (!error) withdrawalsQueued++;
  }

  // 6) HANDOFF: lifecycle invariant says exactly one open market per (coin,
  // schedule) tuple at all times.  Now that this market is terminal, immediately
  // seed the replacement so the slot doesn't sit empty waiting for the next cron
  // tick.  Failures here are NON-FATAL — the seed cron will pick it up.
  //
  // v53 — handoff is now coin-aware.  We re-seed the same coin that just
  // settled, not a hardcoded TROLL.  Look up the coin from the registry via
  // the market's coin_mint; fall back to DEFAULT_COIN if the row predates v53
  // (very old rows) or the mint isn't in the registry (manually inserted).
  let nextMarketId: string | null = null;
  let nextSeedReason: string | null = null;
  try {
    const coin =
      findCoinByMint(marketRow.coin_mint) ?? DEFAULT_COIN;
    const seedResult = await seedSingle(
      coin,
      marketRow.schedule_type,
      preFetchedSnapshot,
    );
    if (seedResult.created) {
      nextMarketId = seedResult.marketId ?? null;
      console.info(
        `[settle] handoff-created market=${marketId} → next=${nextMarketId} ` +
          `coin=${coin.symbol} schedule=${marketRow.schedule_type}` +
          (preFetchedSnapshot ? ` (using pre-fetched snapshot)` : ""),
      );
    } else {
      nextSeedReason = seedResult.reason ?? null;
      console.info(
        `[settle] handoff-noop market=${marketId} coin=${coin.symbol} ` +
          `schedule=${marketRow.schedule_type} reason=${nextSeedReason}`,
      );
    }
  } catch (err) {
    // The cron will retry — log and move on.
    console.error(
      `[settle] handoff-error market=${marketId} schedule=${marketRow.schedule_type} ` +
        `error=${(err as Error).message}`,
    );
    nextSeedReason = `seed_error: ${(err as Error).message}`;
  }

  // 7) AUTO-PAYOUT DISPATCH (v22).  As soon as we've queued withdrawal rows
  // for this market's winners/refundees, kick the payout engine so users
  // get their tokens automatically — no need for them to visit /claims and
  // press a button.
  //
  // Failure is non-fatal: any rows that don't get processed here will be
  // picked up by the standalone payouts cron on its next pass.  We cap at
  // 50 rows per call so a single big settlement doesn't tie up this
  // response (the payouts cron's normal cap is 100).
  //
  // Atomic CAS inside sendWithdrawal means it's safe to call this even if
  // the user-driven claim button fires concurrently — only one process
  // can claim each row.
  if (withdrawalsQueued > 0) {
    try {
      const r = await runPendingWithdrawals(50);
      console.info(
        `[settle] auto-payout market=${marketId} processed=${r.processed} skipped=${r.skipped}`,
      );
    } catch (err) {
      console.warn(
        `[settle] auto-payout-error market=${marketId} reason=${(err as Error).message}` +
          ` (non-fatal — payouts cron will retry)`,
      );
    }
  }

  console.info(
    `[settle] DONE market=${marketId} outcome=${market.outcome ?? "VOID"} ` +
      `withdrawalsQueued=${withdrawalsQueued} nextMarket=${nextMarketId ?? "n/a"}`,
  );

  return {
    marketId,
    outcome: (market.outcome ?? "VOID") as "YES" | "NO" | "VOID",
    voidReason: market.voidReason,
    canonicalMc: market.settlementMc,
    userSettlements: (receipt.userSettlements ?? []).length,
    withdrawalsQueued,
    nextMarketId,
    nextSeedReason,
  };
}

/**
 * Settle every market whose close window has fully elapsed and which hasn't yet
 * been settled. Designed to run on a 30s cron.
 */
export async function settleDueMarkets(): Promise<{ settled: string[]; skipped: string[]; errors: { id: string; error: string }[] }> {
  const sb = db();
  const now = new Date();
  const cutoff = now.toISOString();

  const { data, error } = await sb
    .from("markets")
    .select("id, close_at, status, window_seconds")
    .in("status", ["open", "locked", "settling"])
    .lt("close_at", cutoff)
    .returns<{ id: string; close_at: string; status: string; window_seconds: number }[]>();
  if (error) throw error;

  const settled: string[] = [];
  const skipped: string[] = [];
  const errors: { id: string; error: string }[] = [];

  for (const m of data ?? []) {
    const closeMs = new Date(m.close_at).getTime();
    const windowEndMs = closeMs + m.window_seconds * 1000;
    if (now.getTime() < windowEndMs) {
      skipped.push(`${m.id}:window_not_elapsed`);
      continue;
    }
    try {
      await settleMarketViaWorker(m.id);
      settled.push(m.id);
    } catch (err) {
      const msg = (err as Error).message;
      // "already_in_flight_or_terminal" is benign — another worker is on it
      if (msg === "settlement_already_in_flight_or_terminal" || msg.startsWith("market_already_terminal")) {
        skipped.push(`${m.id}:${msg}`);
      } else {
        errors.push({ id: m.id, error: msg });
      }
    }
  }

  return { settled, skipped, errors };
}
