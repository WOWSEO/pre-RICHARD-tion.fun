import { db, num, type MarketRow, type PositionRow, type TradeRow } from "./supabase";
import type { Market, Position, TradeEvent, AmmState } from "../../src/market/marketTypes";

/**
 * Hydrate a brain Market from DB rows. Reads the market row, all positions,
 * and all trades, then assembles the in-memory object the brain operates on.
 *
 * The brain itself is pure (no I/O). After the engine mutates a Market, we
 * persist the deltas with `syncMarket()`.
 */
export async function loadMarket(marketId: string): Promise<Market | null> {
  const sb = db();

  const { data: marketRow, error: mErr } = await sb
    .from("markets")
    .select("*")
    .eq("id", marketId)
    .maybeSingle<MarketRow>();
  if (mErr) throw mErr;
  if (!marketRow) return null;

  const { data: posRows, error: pErr } = await sb
    .from("positions")
    .select("*")
    .eq("market_id", marketId)
    .returns<PositionRow[]>();
  if (pErr) throw pErr;

  const { data: tradeRows, error: tErr } = await sb
    .from("trades")
    .select("*")
    .eq("market_id", marketId)
    .order("created_at", { ascending: true })
    .returns<TradeRow[]>();
  if (tErr) throw tErr;

  return assembleMarket(marketRow, posRows ?? [], tradeRows ?? []);
}

export function assembleMarket(
  m: MarketRow,
  positions: PositionRow[],
  trades: TradeRow[],
): Market {
  const amm: AmmState = {
    b: num(m.amm_b),
    qYes: num(m.amm_q_yes),
    qNo: num(m.amm_q_no),
  };

  const market: Market = {
    id: m.id,
    symbol: m.symbol,
    question: m.question,
    targetMc: num(m.target_mc),
    closeAt: new Date(m.close_at),
    lockAt: new Date(m.lock_at),
    windowSeconds: m.window_seconds,
    pollCadenceSeconds: m.poll_cadence_seconds,
    scheduleType: m.schedule_type,
    status: m.status,
    amm,
    yesPriceCents: num(m.yes_price_cents),
    noPriceCents: num(m.no_price_cents),
    yesLiquidity: num(m.yes_liquidity),
    noLiquidity: num(m.no_liquidity),
    volume: num(m.volume),
    openInterest: num(m.open_interest),
    settlementMc: m.settlement_mc != null ? num(m.settlement_mc) : null,
    outcome: m.outcome,
    voidReason: m.void_reason,
    createdAt: new Date(m.created_at),
    closedAt: m.settled_at != null ? new Date(m.settled_at) : null,
    positions: positions.map(rowToPosition),
    trades: trades.map(rowToTrade),
  };

  return market;
}

function rowToPosition(r: PositionRow): Position {
  return {
    id: r.id,
    marketId: r.market_id,
    wallet: r.wallet,
    side: r.side,
    shares: num(r.shares),
    averageEntryPriceCents: num(r.average_entry_price_cents),
    costBasisTroll: num(r.cost_basis_troll),
    realizedPnlTroll: num(r.realized_pnl_troll),
    status: r.status,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

function rowToTrade(r: TradeRow): TradeEvent {
  return {
    id: r.id,
    marketId: r.market_id,
    wallet: r.wallet,
    action: r.action,
    amountTroll: num(r.amount_troll),
    shares: num(r.shares),
    priceCents: num(r.price_cents),
    avgPriceCents: num(r.avg_price_cents),
    priceBeforeCents: num(r.price_before_cents),
    priceAfterCents: num(r.price_after_cents),
    timestamp: new Date(r.created_at),
  };
}

/* ========================================================================== */
/* Sync — push brain Market state back to the DB after a mutation             */
/* ========================================================================== */

export interface SyncMarketInput {
  market: Market;
  /** New trade events appended in this transaction (we insert these). */
  newTrades: TradeEvent[];
  /** Positions touched in this transaction (we upsert these). */
  touchedPositions: Position[];
}

/** Thrown when the optimistic version-lock check fails — caller should retry. */
export class OptimisticLockConflict extends Error {
  constructor(marketId: string, expectedVersion: number) {
    super(
      `optimistic_lock_conflict: market ${marketId} expected version ${expectedVersion} but row was modified concurrently`,
    );
    this.name = "OptimisticLockConflict";
  }
}

/**
 * Persist a market mutation.
 *
 * AUDIT FIX:
 *   The previous implementation inserted trades and upserted positions BEFORE
 *   the version-checked market UPDATE.  On lock conflict that left orphan trade
 *   rows referencing a market state that was never updated.
 *
 *   New order:
 *     1. UPDATE markets WHERE version = expected  → claims the version transition
 *     2. INSERT trades                            → only after slot claimed
 *     3. UPSERT positions                         → only after slot claimed
 *
 *   On lock conflict at step 1, NOTHING is written: zero orphans, caller can
 *   safely retry the entire load → mutate → sync cycle.
 *
 *   Risk that remains: if step 2 or step 3 fails (network hiccup, FK violation,
 *   etc.) AFTER step 1 succeeded, market state is committed but trade/position
 *   rows are missing.  This is rare in practice and is logged loudly — recovery
 *   is via admin replay tooling.  Documented in AUDIT.md.
 *
 * Returns the new market version on success.
 */
export async function syncMarket(input: SyncMarketInput, expectedVersion: number): Promise<number> {
  const sb = db();
  const { market, newTrades, touchedPositions } = input;
  const newVersion = expectedVersion + 1;

  // 1) Claim the version transition first.
  const { data: claim, error: claimErr } = await sb
    .from("markets")
    .update({
      status: market.status,
      amm_q_yes: market.amm.qYes.toString(),
      amm_q_no: market.amm.qNo.toString(),
      yes_price_cents: market.yesPriceCents.toString(),
      no_price_cents: market.noPriceCents.toString(),
      yes_liquidity: market.yesLiquidity.toString(),
      no_liquidity: market.noLiquidity.toString(),
      volume: market.volume.toString(),
      open_interest: market.openInterest.toString(),
      settlement_mc: market.settlementMc?.toString() ?? null,
      outcome: market.outcome,
      void_reason: market.voidReason,
      version: newVersion,
    })
    .eq("id", market.id)
    .eq("version", expectedVersion)
    .select("version")
    .maybeSingle<{ version: number }>();

  if (claimErr) throw claimErr;
  if (!claim) throw new OptimisticLockConflict(market.id, expectedVersion);

  // 2) Insert new trade rows.  No conflict possible: we own this version transition.
  if (newTrades.length > 0) {
    const tradeRows = newTrades.map((t) => ({
      id: t.id,
      market_id: t.marketId,
      wallet: t.wallet,
      action: t.action,
      amount_troll: t.amountTroll.toString(),
      shares: t.shares.toString(),
      price_cents: t.priceCents.toString(),
      avg_price_cents: t.avgPriceCents.toString(),
      price_before_cents: t.priceBeforeCents.toString(),
      price_after_cents: t.priceAfterCents.toString(),
    }));
    const { error } = await sb.from("trades").insert(tradeRows);
    if (error) {
      // We just bumped the market version but failed to insert trades. Loud
      // failure so an operator notices; row rollback is not possible without
      // Postgres transactions exposed to us via Supabase REST.
      console.error(
        `[syncMarket] CRITICAL: market ${market.id} v${newVersion} updated but trade insert failed:`,
        error,
      );
      throw error;
    }
  }

  // 3) Upsert touched positions.
  if (touchedPositions.length > 0) {
    const positionRows = touchedPositions.map((p) => ({
      id: p.id,
      market_id: p.marketId,
      wallet: p.wallet,
      side: p.side,
      shares: p.shares.toString(),
      average_entry_price_cents: p.averageEntryPriceCents.toString(),
      cost_basis_troll: p.costBasisTroll.toString(),
      realized_pnl_troll: p.realizedPnlTroll.toString(),
      status: p.status,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await sb
      .from("positions")
      .upsert(positionRows, { onConflict: "id" });
    if (error) {
      console.error(
        `[syncMarket] CRITICAL: market ${market.id} v${newVersion} updated but position upsert failed:`,
        error,
      );
      throw error;
    }
  }

  return newVersion;
}
