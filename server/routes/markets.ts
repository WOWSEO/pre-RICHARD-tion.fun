import { Router } from "express";
import { db, num, type MarketRow, type PositionRow, type TradeRow } from "../db/supabase";
import { assembleMarket, loadMarket, syncMarket, OptimisticLockConflict } from "../db/marketLoader";
import { quoteBuyYes, quoteBuyNo } from "../../src/market/pricingEngine";
import { buyYes, buyNo } from "../../src/market/tradeEngine";
import { isTradingAllowed, tick } from "../../src/market/scheduler";
import { verifyDeposit, escrowTokenAccount } from "../services/escrowVerifier";
import type { Market, Side } from "../../src/market/marketTypes";

export const marketsRouter = Router();

/** How many times to retry the brain mutation on optimistic-lock conflict. */
const MAX_LOCK_RETRIES = 3;

/* ========================================================================== */
/* GET /api/markets — list all                                                */
/* ========================================================================== */
marketsRouter.get("/", async (_req, res, next) => {
  try {
    const sb = db();
    const { data, error } = await sb
      .from("markets")
      .select("*")
      .in("status", ["open", "locked", "settling", "settled", "voided"])
      .order("close_at", { ascending: true })
      .returns<MarketRow[]>();
    if (error) throw error;

    res.json({
      markets: (data ?? []).map(rowToSummary),
      escrowAccount: escrowTokenAccount().toBase58(),
    });
  } catch (err) {
    next(err);
  }
});

/* ========================================================================== */
/* GET /api/markets/:id — single market with positions + trades               */
/* ========================================================================== */
marketsRouter.get("/:id", async (req, res, next) => {
  try {
    const market = await loadMarket(req.params.id!);
    if (!market) return res.status(404).json({ error: "market_not_found" });

    // Update status field if it should have transitioned (open → locked)
    tick(market, new Date());

    res.json({
      market: marketToWire(market),
      escrowAccount: escrowTokenAccount().toBase58(),
    });
  } catch (err) {
    next(err);
  }
});

/* ========================================================================== */
/* POST /api/markets/:id/quote                                                */
/* { side: "YES" | "NO", amountTroll: number }                                */
/* Pure read — runs the brain's quoteBuyYes / quoteBuyNo. No state changes.   */
/* ========================================================================== */
marketsRouter.post("/:id/quote", async (req, res, next) => {
  try {
    const { side, amountTroll } = req.body as { side?: Side; amountTroll?: number };
    if (side !== "YES" && side !== "NO") {
      return res.status(400).json({ error: "invalid_side" });
    }
    const amt = Number(amountTroll);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "invalid_amount" });
    }

    const market = await loadMarket(req.params.id!);
    if (!market) return res.status(404).json({ error: "market_not_found" });
    tick(market, new Date());
    if (!isTradingAllowed(market)) {
      return res.status(409).json({ error: "market_not_tradable", status: market.status });
    }

    const quote = side === "YES" ? quoteBuyYes(market, amt) : quoteBuyNo(market, amt);
    res.json({ quote });
  } catch (err) {
    next(err);
  }
});

/* ========================================================================== */
/* POST /api/markets/:id/enter                                                */
/* {                                                                          */
/*   wallet: string, side: "YES" | "NO", amountTroll: number, signature: string */
/* }                                                                          */
/*                                                                            */
/* AUDIT FIX: previously a single load → mutate → sync attempt.  On version   */
/* conflict (concurrent trade) the user got a 500 and their TROLL was already */
/* in escrow. Now we retry the load → mutate → sync cycle up to 3 times; only */
/* after all retries fail do we mark the deposit as 'failed' so the admin can */
/* refund.                                                                    */
/* ========================================================================== */
marketsRouter.post("/:id/enter", async (req, res, next) => {
  const sb = db();
  try {
    const body = req.body as {
      wallet?: string;
      side?: Side;
      amountTroll?: number;
      signature?: string;
    };
    const { wallet, side, amountTroll, signature } = body;
    if (!wallet || (side !== "YES" && side !== "NO") || !signature) {
      return res.status(400).json({ error: "invalid_request" });
    }
    const amt = Number(amountTroll);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "invalid_amount" });
    }

    const startedAt = Date.now();
    const shortSig = `${signature.slice(0, 8)}…${signature.slice(-6)}`;
    console.info(
      `[entry] BEGIN market=${req.params.id} wallet=${wallet} side=${side} amt=${amt} sig=${shortSig}`,
    );

    // 1) Reject duplicate signature submissions early
    const { data: existing } = await sb
      .from("escrow_deposits")
      .select("id, status, position_id")
      .eq("signature", signature)
      .maybeSingle();
    if (existing) {
      console.warn(
        `[entry] duplicate-signature market=${req.params.id} sig=${shortSig} existingStatus=${existing.status} positionId=${existing.position_id}`,
      );
      return res.status(409).json({
        error: "signature_already_submitted",
        depositStatus: existing.status,
        positionId: existing.position_id,
      });
    }

    // 2) Ensure user row exists (positions/trades have FK to users.wallet)
    await sb.from("users").upsert({ wallet, last_seen_at: new Date().toISOString() }, { onConflict: "wallet" });

    // 3) Insert deposit row as 'pending' — protected by UNIQUE(signature)
    const { data: deposit, error: depErr } = await sb
      .from("escrow_deposits")
      .insert({
        signature,
        market_id: req.params.id!,
        wallet,
        amount_troll: amt.toString(),
        status: "pending",
        side,
      })
      .select("id")
      .single<{ id: number }>();
    if (depErr) throw depErr;
    console.info(`[entry] deposit-row-inserted id=${deposit.id} sig=${shortSig}`);

    // 4) Verify the on-chain transfer
    console.info(`[entry] verifying-on-chain sig=${shortSig}`);
    const result = await verifyDeposit({
      signature,
      expectedSource: wallet,
      expectedAmountTroll: amt,
    });

    if (!result.ok) {
      console.warn(
        `[entry] verification-FAILED depositId=${deposit.id} sig=${shortSig} reason=${result.reason}`,
      );
      await sb
        .from("escrow_deposits")
        .update({ status: "failed", failure_reason: result.reason })
        .eq("id", deposit.id);
      return res.status(422).json({ error: "deposit_verification_failed", reason: result.reason });
    }
    console.info(
      `[entry] verification-OK depositId=${deposit.id} sig=${shortSig} actualAmt=${result.actualAmountTroll}`,
    );

    // 5) Retry loop: load → brain → sync.  On lock conflict, reload and try again.
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
      try {
        // Load fresh
        const { data: marketRowRaw, error: mErr } = await sb
          .from("markets")
          .select("*")
          .eq("id", req.params.id!)
          .maybeSingle<MarketRow>();
        if (mErr) throw mErr;
        if (!marketRowRaw) {
          await sb.from("escrow_deposits").update({ status: "failed", failure_reason: "market_not_found" }).eq("id", deposit.id);
          return res.status(404).json({ error: "market_not_found" });
        }
        const expectedVersion = marketRowRaw.version;

        const { data: posRows } = await sb.from("positions").select("*").eq("market_id", req.params.id!).returns<PositionRow[]>();
        const { data: tradeRows } = await sb
          .from("trades")
          .select("*")
          .eq("market_id", req.params.id!)
          .order("created_at", { ascending: true })
          .returns<TradeRow[]>();
        const market = assembleMarket(marketRowRaw, posRows ?? [], tradeRows ?? []);

        tick(market, new Date());
        if (!isTradingAllowed(market)) {
          await sb
            .from("escrow_deposits")
            .update({ status: "failed", failure_reason: `market_not_tradable: ${market.status}` })
            .eq("id", deposit.id);
          return res.status(409).json({ error: "market_not_tradable", status: market.status });
        }

        // Snapshot state so we know which trades and positions are "new"
        const tradeIdsBefore = new Set(market.trades.map((t) => t.id));
        const beforePositions = new Map<string, Market["positions"][number]>(
          market.positions.map((p) => [p.id, structuredClone(p)]),
        );

        // Run brain mutation
        const ensureUser = { wallet, trollBalance: 0 };
        const receipt = side === "YES"
          ? buyYes(ensureUser, market, result.actualAmountTroll)
          : buyNo(ensureUser, market, result.actualAmountTroll);

        const newTrades = market.trades.filter((t) => !tradeIdsBefore.has(t.id));
        const touchedPositions = market.positions.filter((p) => {
          const prior = beforePositions.get(p.id);
          if (!prior) return true;
          return (
            prior.shares !== p.shares ||
            prior.costBasisTroll !== p.costBasisTroll ||
            prior.averageEntryPriceCents !== p.averageEntryPriceCents ||
            prior.status !== p.status
          );
        });

        console.info(
          `[entry] brain-buy depositId=${deposit.id} attempt=${attempt + 1} ` +
            `shares=${receipt.trade.shares.toFixed(2)} avg=${receipt.trade.avgPriceCents.toFixed(1)}c ` +
            `priceBefore=${receipt.trade.priceBeforeCents.toFixed(1)}c ` +
            `priceAfter=${receipt.trade.priceAfterCents.toFixed(1)}c ` +
            `volume=${market.volume.toFixed(2)} OI=${market.openInterest.toFixed(2)}`,
        );

        // Sync — throws OptimisticLockConflict on race
        await syncMarket({ market, newTrades, touchedPositions }, expectedVersion);
        console.info(
          `[entry] synced depositId=${deposit.id} version=${expectedVersion}→${expectedVersion + 1} ` +
            `newTrades=${newTrades.length} touchedPositions=${touchedPositions.length}`,
        );

        // Mark deposit confirmed; link trade_id and position_id
        await sb
          .from("escrow_deposits")
          .update({
            status: "confirmed",
            confirmed_at: new Date().toISOString(),
            trade_id: receipt.trade.id,
            position_id: receipt.positionId,
          })
          .eq("id", deposit.id);

        // Stamp the trade with the escrow signature for auditability
        await sb
          .from("trades")
          .update({ escrow_signature: signature })
          .eq("id", receipt.trade.id);

        const elapsedMs = Date.now() - startedAt;
        console.info(
          `[entry] DONE depositId=${deposit.id} positionId=${receipt.positionId} ` +
            `tradeId=${receipt.trade.id} elapsedMs=${elapsedMs}`,
        );

        return res.status(201).json({
          ok: true,
          depositId: deposit.id,
          tradeId: receipt.trade.id,
          positionId: receipt.positionId,
          market: marketToWire(market),
        });
      } catch (err) {
        if (err instanceof OptimisticLockConflict) {
          lastErr = err;
          // Backoff: 50ms × attempt, jittered.
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1) + Math.random() * 30));
          continue;
        }
        throw err;
      }
    }

    // All retries exhausted — leave deposit pending so admin can manually resolve
    // (refund, or call this endpoint again with the same signature for replay).
    await sb
      .from("escrow_deposits")
      .update({ status: "failed", failure_reason: `lock_contention_after_${MAX_LOCK_RETRIES}_retries` })
      .eq("id", deposit.id);
    console.error(`[markets/enter] lock contention exhausted retries for deposit ${deposit.id}`, lastErr);
    return res.status(503).json({ error: "lock_contention", reason: lastErr?.message });
  } catch (err) {
    next(err);
  }
});

/* ========================================================================== */
/* Wire format helpers                                                        */
/* ========================================================================== */

function rowToSummary(m: MarketRow) {
  return {
    id: m.id,
    symbol: m.symbol,
    question: m.question,
    scheduleType: m.schedule_type,
    targetMc: num(m.target_mc),
    closeAt: m.close_at,
    lockAt: m.lock_at,
    status: m.status,
    yesPriceCents: num(m.yes_price_cents),
    noPriceCents: num(m.no_price_cents),
    volume: num(m.volume),
    openInterest: num(m.open_interest),
    yesLiquidity: num(m.yes_liquidity),
    noLiquidity: num(m.no_liquidity),
    settlementMc: m.settlement_mc != null ? num(m.settlement_mc) : null,
    outcome: m.outcome,
    voidReason: m.void_reason,
    version: m.version,
  };
}

export function marketToWire(m: Market) {
  return {
    id: m.id,
    symbol: m.symbol,
    question: m.question,
    scheduleType: m.scheduleType,
    targetMc: m.targetMc,
    closeAt: m.closeAt.toISOString(),
    lockAt: m.lockAt.toISOString(),
    windowSeconds: m.windowSeconds,
    status: m.status,
    yesPriceCents: m.yesPriceCents,
    noPriceCents: m.noPriceCents,
    yesLiquidity: m.yesLiquidity,
    noLiquidity: m.noLiquidity,
    volume: m.volume,
    openInterest: m.openInterest,
    settlementMc: m.settlementMc,
    outcome: m.outcome,
    voidReason: m.voidReason,
    positions: m.positions.map((p) => ({
      id: p.id,
      wallet: p.wallet,
      side: p.side,
      shares: p.shares,
      averageEntryPriceCents: p.averageEntryPriceCents,
      costBasisTroll: p.costBasisTroll,
      realizedPnlTroll: p.realizedPnlTroll,
      status: p.status,
    })),
    trades: m.trades.map((t) => ({
      id: t.id,
      wallet: t.wallet,
      action: t.action,
      amountTroll: t.amountTroll,
      shares: t.shares,
      priceCents: t.priceCents,
      avgPriceCents: t.avgPriceCents,
      priceBeforeCents: t.priceBeforeCents,
      priceAfterCents: t.priceAfterCents,
      timestamp: t.timestamp.toISOString(),
    })),
  };
}
