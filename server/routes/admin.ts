import { Router, type RequestHandler } from "express";
import { db, type MarketRow, type EscrowDepositRow, type PositionRow } from "../db/supabase";
import { loadEnv } from "../env";
import { settleMarketViaWorker } from "../services/settlementOrchestrator";
import { runPendingWithdrawals } from "../services/payoutEngine";
import { escrowTokenAccount } from "../services/escrowVerifier";
import { ensureOneActivePerSchedule, seedSingle } from "../services/marketSeeder";
import type { ScheduleType } from "../../src/market/marketTypes";

export const adminRouter = Router();

/* Admin gate. Compares header `x-admin-key` to env. Logs every call. */
const requireAdmin: RequestHandler = (req, res, next) => {
  const key = req.header("x-admin-key");
  const envKey = loadEnv().ADMIN_API_KEY;
  if (!key || key !== envKey) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
};

adminRouter.use(requireAdmin);

/* Helper: log to admin_actions */
async function logAction(
  actor: string,
  action: string,
  payload: unknown,
  result: "ok" | "error",
  errorText: string | null,
): Promise<void> {
  try {
    await db().from("admin_actions").insert({
      actor,
      action,
      payload: payload ?? null,
      result,
      error_text: errorText,
    });
  } catch (err) {
    console.error("[admin] failed to log action", err);
  }
}

/* ========================================================================== */
/* POST /api/admin/markets                                                    */
/* { scheduleType: "15m" | "hourly" | "daily" }                                */
/*                                                                            */
/* Creates ONE market for that schedule type, ONLY if no active market exists */
/* for it.  The opening MC threshold is taken from a live DexScreener         */
/* snapshot at insert time — admin no longer supplies a targetMc.             */
/*                                                                            */
/* Idempotent: if a market is already active for this schedule, returns 200   */
/* with `created: false` and the existing market's id.                         */
/* ========================================================================== */
adminRouter.post("/markets", async (req, res) => {
  const body = req.body as { scheduleType?: string };
  const actor = req.header("x-admin-actor") ?? "admin";

  try {
    const scheduleType = body.scheduleType as ScheduleType | undefined;
    if (scheduleType !== "15m" && scheduleType !== "hourly" && scheduleType !== "daily") {
      throw new Error("invalid_schedule_type");
    }
    const result = await seedSingle(scheduleType);
    await logAction(actor, "create_market", { scheduleType, result }, "ok", null);
    res.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
      marketId: result.marketId,
      reason: result.reason,
      openMc: result.snapshot?.marketCapUsd ?? null,
      openPriceUsd: result.snapshot?.priceUsd ?? null,
      openSource: result.snapshot?.source ?? null,
    });
  } catch (err) {
    const msg = (err as Error).message;
    await logAction(actor, "create_market", body, "error", msg);
    res.status(400).json({ error: msg });
  }
});

/* ========================================================================== */
/* POST /api/admin/seed-markets                                               */
/* Body: ignored.                                                             */
/*                                                                            */
/* Walks all 3 schedule types and seeds any empty slot.  Returns a per-       */
/* schedule report.                                                           */
/* ========================================================================== */
adminRouter.post("/seed-markets", async (_req, res) => {
  const actor = _req.header("x-admin-actor") ?? "admin";
  try {
    const { results } = await ensureOneActivePerSchedule();
    await logAction(actor, "seed_markets", { results }, "ok", null);
    res.json({
      ok: true,
      results: results.map((r) => ({
        scheduleType: r.scheduleType,
        created: r.created,
        marketId: r.marketId,
        reason: r.reason,
        openMc: r.snapshot?.marketCapUsd ?? null,
        openPriceUsd: r.snapshot?.priceUsd ?? null,
        openSource: r.snapshot?.source ?? null,
      })),
    });
  } catch (err) {
    const msg = (err as Error).message;
    await logAction(actor, "seed_markets", {}, "error", msg);
    res.status(500).json({ error: msg });
  }
});

/* ========================================================================== */
/* POST /api/admin/void-market                                                */
/* { marketId, reason }                                                       */
/* AUDIT FIX: now atomic — the status update is conditional on the market not */
/* being terminal yet (avoids racing a settlement worker into a void-then-    */
/* settle conflict).                                                          */
/* ========================================================================== */
adminRouter.post("/void-market", async (req, res) => {
  const sb = db();
  const actor = req.header("x-admin-actor") ?? "admin";
  const body = req.body as { marketId?: string; reason?: string };

  try {
    if (!body.marketId) throw new Error("missing_market_id");
    const reason = body.reason ?? "admin_void";

    const { data: m, error: mErr } = await sb
      .from("markets")
      .select("*")
      .eq("id", body.marketId)
      .maybeSingle<MarketRow>();
    if (mErr) throw mErr;
    if (!m) throw new Error("market_not_found");
    if (m.status === "settled" || m.status === "voided") {
      throw new Error(`market_already_terminal: ${m.status}`);
    }

    // Atomic claim — refuse to void if a settlement worker has moved status
    // forward since we read the row.
    const { data: claimed, error: claimErr } = await sb
      .from("markets")
      .update({
        status: "voided",
        outcome: "VOID",
        void_reason: reason,
        settled_at: new Date().toISOString(),
        version: m.version + 1,
      })
      .eq("id", m.id)
      .eq("version", m.version)
      .not("status", "in", "(settled,voided)")
      .select("id")
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claimed) throw new Error("market_state_changed_during_void");

    // Mark every open/locked position void_refunded
    await sb
      .from("positions")
      .update({ status: "void_refunded", updated_at: new Date().toISOString() })
      .eq("market_id", m.id)
      .in("status", ["open", "locked"]);

    // Queue refunds.  Cost basis already reflects partial exits (the brain's
    // sellYes/sellNo reduces it proportionally), so this is the correct amount
    // to refund the user.
    const { data: positions } = await sb
      .from("positions")
      .select("*")
      .eq("market_id", m.id)
      .returns<PositionRow[]>();

    // Idempotent — don't double-queue refunds if void was already partially run
    const { data: existingRefunds } = await sb
      .from("escrow_withdrawals")
      .select("position_id")
      .eq("market_id", m.id)
      .eq("reason", "refund");
    const refundedPositions = new Set(
      (existingRefunds ?? []).map((r) => r.position_id).filter((p): p is string => p != null),
    );

    let queued = 0;
    for (const p of positions ?? []) {
      if (refundedPositions.has(p.id)) continue;
      const cost = Number.parseFloat(p.cost_basis_troll);
      if (!Number.isFinite(cost) || cost <= 0) continue;
      await sb.from("escrow_withdrawals").insert({
        market_id: m.id,
        wallet: p.wallet,
        amount_troll: cost.toString(),
        reason: "refund",
        status: "pending",
        position_id: p.id,
      });
      queued++;
    }

    await logAction(actor, "void_market", { marketId: m.id, reason, refundsQueued: queued }, "ok", null);
    res.json({ ok: true, refundsQueued: queued });
  } catch (err) {
    const msg = (err as Error).message;
    await logAction(actor, "void_market", body, "error", msg);
    res.status(400).json({ error: msg });
  }
});

/* ========================================================================== */
/* POST /api/admin/settle                                                     */
/* { marketId } — Triggers settlement worker for one market.                  */
/* ========================================================================== */
adminRouter.post("/settle", async (req, res) => {
  const actor = req.header("x-admin-actor") ?? "admin";
  const body = req.body as { marketId?: string };
  try {
    if (!body.marketId) throw new Error("missing_market_id");
    const result = await settleMarketViaWorker(body.marketId);
    await logAction(actor, "settle_market", body, "ok", null);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = (err as Error).message;
    await logAction(actor, "settle_market", body, "error", msg);
    res.status(400).json({ error: msg });
  }
});

/* ========================================================================== */
/* POST /api/admin/payouts/run                                                */
/* Sends every pending escrow_withdrawal as an SPL transfer.                  */
/* ========================================================================== */
adminRouter.post("/payouts/run", async (req, res) => {
  const actor = req.header("x-admin-actor") ?? "admin";
  const limit = Number((req.body as { limit?: number })?.limit ?? 50);
  try {
    const result = await runPendingWithdrawals(limit);
    await logAction(actor, "run_payouts", { limit }, "ok", null);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = (err as Error).message;
    await logAction(actor, "run_payouts", { limit }, "error", msg);
    res.status(500).json({ error: msg });
  }
});

/* ========================================================================== */
/* POST /api/admin/payouts/retry-failed                                       */
/* { id }  — reset a single failed withdrawal back to pending so it can run.   */
/* ========================================================================== */
adminRouter.post("/payouts/retry-failed", async (req, res) => {
  const actor = req.header("x-admin-actor") ?? "admin";
  const body = req.body as { id?: number };
  try {
    if (!Number.isInteger(body.id)) throw new Error("missing_id");
    const sb = db();
    const { data, error } = await sb
      .from("escrow_withdrawals")
      .update({ status: "pending", failure_reason: null })
      .eq("id", body.id!)
      .eq("status", "failed")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("no_failed_withdrawal_with_that_id");
    await logAction(actor, "retry_failed_payout", { id: body.id }, "ok", null);
    res.json({ ok: true, id: body.id });
  } catch (err) {
    const msg = (err as Error).message;
    await logAction(actor, "retry_failed_payout", body, "error", msg);
    res.status(400).json({ error: msg });
  }
});

/* ========================================================================== */
/* GET /api/admin/overview                                                    */
/* ========================================================================== */
adminRouter.get("/overview", async (_req, res, next) => {
  const sb = db();
  try {
    const [markets, deposits, withdrawals] = await Promise.all([
      sb.from("markets").select("*").order("close_at", { ascending: true }),
      sb.from("escrow_deposits").select("*").order("id", { ascending: false }).limit(50),
      sb.from("escrow_withdrawals").select("*").order("id", { ascending: false }).limit(50),
    ]);

    const escrowTotal = (deposits.data as EscrowDepositRow[] | null ?? [])
      .filter((d) => d.status === "confirmed")
      .reduce((acc, d) => acc + Number.parseFloat(d.amount_troll), 0);
    const pendingWithdrawalTotal = (withdrawals.data as { amount_troll: string; status: string }[] | null ?? [])
      .filter((w) => w.status === "pending" || w.status === "sent")
      .reduce((acc, w) => acc + Number.parseFloat(w.amount_troll), 0);

    res.json({
      escrowAccount: escrowTokenAccount().toBase58(),
      escrowConfirmedTotal: escrowTotal,
      pendingWithdrawalTotal,
      markets: markets.data ?? [],
      recentDeposits: deposits.data ?? [],
      recentWithdrawals: withdrawals.data ?? [],
    });
  } catch (err) {
    next(err);
  }
});
