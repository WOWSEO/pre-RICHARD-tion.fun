import { Router } from "express";
import { db, type MarketRow, type PositionRow, type TradeRow } from "../db/supabase";
import { assembleMarket, syncMarket, OptimisticLockConflict } from "../db/marketLoader";
import { sellYes, sellNo } from "../../src/market/tradeEngine";
import { isTradingAllowed, tick } from "../../src/market/scheduler";
import { marketToWire } from "./markets";
import { sendWithdrawal } from "../services/payoutEngine";
import { verifyWalletSignature, buildExitMessage } from "../util/walletSignature";

export const positionsRouter = Router();

const MAX_LOCK_RETRIES = 3;
/** Reject signed messages older than this — replay-attack window. */
const EXIT_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/* ========================================================================== */
/* POST /api/positions/:id/exit                                                */
/* { wallet, sharesToSell?, signature, timestamp }                            */
/*                                                                            */
/* v55 — wallet signature now required.  Caller signs the canonical exit     */
/* message client-side and posts the base64 signature alongside the request. */
/* Server rebuilds the message from the request fields and verifies the     */
/* signature against the wallet's pubkey before doing anything else.        */
/*                                                                            */
/* Steps:                                                                     */
/*   0. Verify wallet signature over (wallet, positionId, shares, timestamp) */
/*   1. Validate caller owns the position                                     */
/*   2. Check trading allowed (lock window not entered)                       */
/*   3. Run brain sellYes/sellNo                                              */
/*   4. Sync market + trade + position                                        */
/*   5. Insert escrow_withdrawals row (reason='exit', status='pending')       */
/*                                                                            */
/* AUDIT FIX: retry loop on OptimisticLockConflict; the position-status       */
/* re-check is inside the loop so a concurrent exit can't race past us.       */
/* ========================================================================== */
positionsRouter.post("/:id/exit", async (req, res, next) => {
  const sb = db();
  try {
    const { wallet, sharesToSell, signature, timestamp } = req.body as {
      wallet?: string;
      sharesToSell?: number;
      signature?: string;
      timestamp?: number;
    };
    if (!wallet) return res.status(400).json({ error: "missing_wallet" });
    if (!signature) return res.status(400).json({ error: "missing_signature" });
    if (typeof timestamp !== "number") return res.status(400).json({ error: "missing_timestamp" });

    // 0) Reject stale signatures — replay-attack window.  An attacker who
    // intercepts a valid signature can't reuse it past 5 minutes.
    const age = Date.now() - timestamp;
    if (age < -60_000 || age > EXIT_SIGNATURE_MAX_AGE_MS) {
      return res.status(401).json({ error: "signature_expired", ageMs: age });
    }

    // 0b) Rebuild the canonical message from the request fields and verify
    // the signature is valid for the claimed wallet.  If the client lied
    // about anything (positionId, shares, timestamp, wallet), the signature
    // won't verify and we reject before any DB work.
    const canonicalMessage = buildExitMessage({
      wallet,
      positionId: req.params.id!,
      sharesToSell: sharesToSell != null ? sharesToSell : "all",
      timestamp,
    });
    const sigOk = verifyWalletSignature({
      wallet,
      message: canonicalMessage,
      signature,
    });
    if (!sigOk) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
      try {
        // 1) Load position row
        const { data: pos, error: pErr } = await sb
          .from("positions")
          .select("*")
          .eq("id", req.params.id!)
          .maybeSingle<PositionRow>();
        if (pErr) throw pErr;
        if (!pos) return res.status(404).json({ error: "position_not_found" });
        if (pos.wallet !== wallet) return res.status(403).json({ error: "wrong_wallet" });
        if (pos.status !== "open") return res.status(409).json({ error: "position_not_open", status: pos.status });

        const sharesNumber = Number.parseFloat(pos.shares);
        if (!(sharesNumber > 0)) {
          return res.status(409).json({ error: "no_shares_to_exit" });
        }
        const sellShares = sharesToSell != null ? Math.min(Number(sharesToSell), sharesNumber) : sharesNumber;
        if (!Number.isFinite(sellShares) || sellShares <= 0) {
          return res.status(400).json({ error: "invalid_shares_to_sell" });
        }

        // 2) Load market
        const { data: marketRow, error: mErr } = await sb
          .from("markets")
          .select("*")
          .eq("id", pos.market_id)
          .maybeSingle<MarketRow>();
        if (mErr) throw mErr;
        if (!marketRow) return res.status(404).json({ error: "market_not_found" });
        const expectedVersion = marketRow.version;

        const { data: posRows } = await sb.from("positions").select("*").eq("market_id", marketRow.id).returns<PositionRow[]>();
        const { data: tradeRows } = await sb
          .from("trades")
          .select("*")
          .eq("market_id", marketRow.id)
          .order("created_at", { ascending: true })
          .returns<TradeRow[]>();
        const market = assembleMarket(marketRow, posRows ?? [], tradeRows ?? []);

        tick(market, new Date());
        if (!isTradingAllowed(market)) {
          return res.status(409).json({ error: "market_locked_no_exits", status: market.status });
        }

        // 3) Snapshot before
        const tradeIdsBefore = new Set(market.trades.map((t) => t.id));
        const beforePositions = new Map(market.positions.map((p) => [p.id, structuredClone(p)]));

        // 4) Run sell
        const userStub = { wallet, trollBalance: 0 };
        const receipt =
          pos.side === "YES"
            ? sellYes(userStub, market, sellShares)
            : sellNo(userStub, market, sellShares);

        const newTrades = market.trades.filter((t) => !tradeIdsBefore.has(t.id));
        const touchedPositions = market.positions.filter((p) => {
          const prior = beforePositions.get(p.id);
          if (!prior) return true;
          return (
            prior.shares !== p.shares ||
            prior.costBasisTroll !== p.costBasisTroll ||
            prior.averageEntryPriceCents !== p.averageEntryPriceCents ||
            prior.realizedPnlTroll !== p.realizedPnlTroll ||
            prior.status !== p.status
          );
        });

        await syncMarket({ market, newTrades, touchedPositions }, expectedVersion);

        // 5) Queue withdrawal — `proceedsTroll` is what user receives back from escrow
        const proceedsTroll = receipt.quote.trollAmount;
        const { data: withdrawal, error: wErr } = await sb
          .from("escrow_withdrawals")
          .insert({
            market_id: market.id,
            wallet,
            amount_troll: proceedsTroll.toString(),
            reason: "exit",
            status: "pending",
            position_id: pos.id,
            trade_id: receipt.trade.id,
          })
          .select("id")
          .single<{ id: number }>();
        if (wErr) throw wErr;

        return res.json({
          ok: true,
          withdrawalId: withdrawal.id,
          proceedsTroll,
          tradeId: receipt.trade.id,
          market: marketToWire(market),
        });
      } catch (err) {
        if (err instanceof OptimisticLockConflict) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1) + Math.random() * 30));
          continue;
        }
        throw err;
      }
    }

    console.error(`[positions/exit] lock contention exhausted retries`, lastErr);
    return res.status(503).json({ error: "lock_contention", reason: lastErr?.message });
  } catch (err) {
    next(err);
  }
});

/* ========================================================================== */
/* GET /api/positions?wallet=...                                              */
/* ========================================================================== */
positionsRouter.get("/", async (req, res, next) => {
  try {
    const wallet = req.query.wallet;
    if (typeof wallet !== "string" || wallet.length === 0) {
      return res.status(400).json({ error: "missing_wallet_query_param" });
    }
    const sb = db();
    const { data, error } = await sb
      .from("positions")
      .select("*")
      .eq("wallet", wallet)
      .order("updated_at", { ascending: false })
      .returns<PositionRow[]>();
    if (error) throw error;
    res.json({ positions: data ?? [] });
  } catch (err) {
    next(err);
  }
});

/* ========================================================================== */
/* GET /api/positions/withdrawals?wallet=...                                  */
/* Show the user their claimable / pending payouts.                           */
/* ========================================================================== */
positionsRouter.get("/withdrawals", async (req, res, next) => {
  try {
    const wallet = req.query.wallet;
    if (typeof wallet !== "string") return res.status(400).json({ error: "missing_wallet" });
    const sb = db();
    const { data, error } = await sb
      .from("escrow_withdrawals")
      .select("*")
      .eq("wallet", wallet)
      .order("id", { ascending: false });
    if (error) throw error;
    res.json({ withdrawals: data ?? [] });
  } catch (err) {
    next(err);
  }
});

/* ========================================================================== */
/* POST /api/positions/withdrawals/:id/claim                                  */
/* { wallet: string }                                                         */
/*                                                                            */
/* User-driven claim: triggers the SAME server-side `sendWithdrawal()` that   */
/* the admin /api/admin/payouts/run uses, but for one specific withdrawal id. */
/*                                                                            */
/* Security model:                                                            */
/*   - The withdrawal row carries the destination wallet (set when the row    */
/*     was created by the settle/exit flow).  We require the caller to        */
/*     supply that wallet, and we 403 if it doesn't match.  Funds always go   */
/*     to the wallet on the row, never to the requester.                      */
/*   - A spoofed wallet param can only TRIGGER a real owner's claim — they    */
/*     can't redirect it.  Worst case: the attacker burns operator SOL fees.  */
/*     Rate-limit at the proxy layer in production.                           */
/*   - The atomic CAS in sendWithdrawal (status='pending' → 'sent') means     */
/*     concurrent claims can't double-spend.                                  */
/* ========================================================================== */
positionsRouter.post("/withdrawals/:id/claim", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id ?? "", 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid_id" });

    const { wallet } = req.body as { wallet?: string };
    if (!wallet || typeof wallet !== "string") {
      return res.status(400).json({ error: "missing_wallet" });
    }

    // Confirm the withdrawal exists and belongs to this wallet.
    const sb = db();
    const { data: row, error } = await sb
      .from("escrow_withdrawals")
      .select("id, wallet, status, reason, amount_troll, market_id")
      .eq("id", id)
      .maybeSingle<{
        id: number;
        wallet: string;
        status: string;
        reason: string;
        amount_troll: string;
        market_id: string;
      }>();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: "withdrawal_not_found" });
    if (row.wallet !== wallet) return res.status(403).json({ error: "wrong_wallet" });

    console.info(
      `[claim] wallet=${wallet} id=${id} market=${row.market_id} reason=${row.reason} amount=${row.amount_troll} status=${row.status}`,
    );

    if (row.status === "confirmed") {
      return res.json({ ok: true, status: "confirmed", reason: "already_confirmed" });
    }
    if (row.status === "sent") {
      // Already broadcast — let the cluster confirm it; no-op.
      return res.json({ ok: true, status: "sent", reason: "already_in_flight" });
    }
    if (row.status === "failed") {
      return res.status(409).json({
        error: "withdrawal_failed",
        reason: "Admin must reset the row before retrying.",
      });
    }
    // status === "pending" — go.

    const result = await sendWithdrawal(id);
    console.info(
      `[claim] result wallet=${wallet} id=${id} ok=${result.ok} reason=${result.reason ?? "ok"} sig=${result.signature ?? "n/a"}`,
    );

    if (!result.ok) {
      // Map specific failure reasons to clean status codes.
      if (result.reason === "not_claimable") {
        return res.status(409).json({ error: "not_claimable" });
      }
      return res.status(500).json({ error: "send_failed", reason: result.reason });
    }
    res.json({ ok: true, status: "confirmed", signature: result.signature });
  } catch (err) {
    next(err);
  }
});
