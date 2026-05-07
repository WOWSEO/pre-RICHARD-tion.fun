import { Router, type RequestHandler } from "express";
import { db, type MarketRow, type EscrowDepositRow, type PositionRow } from "../db/supabase";
import { loadEnv } from "../env";
import { settleMarketViaWorker } from "../services/settlementOrchestrator";
import { runPendingWithdrawals } from "../services/payoutEngine";
import { escrowTokenAccount } from "../services/escrowVerifier";
import { ensureOneActivePerSchedule, seedSingle } from "../services/marketSeeder";
import { tickMarkets } from "../services/tickService";
import { buildManualSnapshot } from "../services/marketSnapshot";
import { reconcileEscrowDeposits } from "../services/escrowReconciler";
import type { ScheduleType } from "../../src/market/marketTypes";

export const adminRouter = Router();

/* Admin gate. Accepts EITHER header:
 *   - `x-admin-key`     (legacy, used by the admin console UI)
 *   - `x-admin-api-key` (per the production cron-job spec — clearer name
 *                        for external automation, e.g. Render Cron Job hitting
 *                        the API via curl).
 * Both compare to the same ADMIN_API_KEY env var.  Either works; the request
 * is authenticated if either matches. */
const requireAdmin: RequestHandler = (req, res, next) => {
  const key = req.header("x-admin-key") ?? req.header("x-admin-api-key");
  const envKey = loadEnv().ADMIN_API_KEY;
  if (!key || key !== envKey) {
    // v50 — diagnostic logging.  When the cron returns 401, we have no
    // way to tell whether the header is missing, the env var is missing,
    // or both exist but differ (whitespace, length, encoding).  This logs
    // enough to diagnose without exposing the actual secret.
    const headerSent = !!key;
    const envSet = !!envKey;
    const keyLen = key?.length ?? 0;
    const envLen = envKey?.length ?? 0;
    const keyFingerprint = key
      ? `${key.slice(0, 2)}…${key.slice(-2)}`
      : "(none)";
    const envFingerprint = envKey
      ? `${envKey.slice(0, 2)}…${envKey.slice(-2)}`
      : "(none)";
    console.warn(
      `[admin-auth] DENIED url=${req.path} ` +
        `headerSent=${headerSent} envSet=${envSet} ` +
        `keyLen=${keyLen} envLen=${envLen} ` +
        `keyFp=${keyFingerprint} envFp=${envFingerprint} ` +
        `match=${key === envKey}`,
    );
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
/* POST /api/admin/tick-markets                                               */
/* Body: ignored.                                                             */
/*                                                                            */
/* Production market automation in a single call.  Settles every expired      */
/* market and ensures exactly one active market per schedule_type.  Wired to  */
/* a 1-minute cron (Render Cron Job, GitHub Actions, cron-job.org).           */
/*                                                                            */
/* Returns: { settled, created, active, skipped, errors, elapsedMs }.         */
/*                                                                            */
/* Auth: x-admin-key OR x-admin-api-key header (both accepted, see            */
/* requireAdmin above).                                                       */
/* ========================================================================== */
adminRouter.post("/tick-markets", async (req, res) => {
  const actor = req.header("x-admin-actor") ?? "cron";
  try {
    const result = await tickMarkets();
    await logAction(
      actor,
      "tick_markets",
      {
        settledCount: result.settled.length,
        createdCount: result.created.length,
        skippedCount: result.skipped.length,
        errorCount: result.errors.length,
        elapsedMs: result.elapsedMs,
        // Per-market error details captured in metadata so the response
        // status can stay 200 (the tick still made forward progress).
        perMarketErrors: result.errors,
      },
      "ok",
      null,
    );
    // 200 even with per-market errors — the tick advances the lifecycle as
    // far as it can each call.  A 5xx would mask the partial progress.
    res.json(result);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[tick] FATAL ${msg}`);
    await logAction(actor, "tick_markets", {}, "error", msg);
    res.status(500).json({ error: "tick_failed", message: msg });
  }
});

/* ========================================================================== */
/* POST /api/admin/seed-markets-from-manual-snapshot                          */
/* Body: { marketCap: number, priceUsd?: number, source?: string }            */
/*                                                                            */
/* ⚠ EMERGENCY FALLBACK ONLY ⚠                                                */
/*                                                                            */
/* This endpoint is for use during a CONFIRMED prolonged outage of both       */
/* DexScreener and GeckoTerminal.  It seeds whichever of {15m, hourly, daily} */
/* are currently empty using ONE shared operator-supplied market cap.  The    */
/* shared value violates the v19 product rule that "each schedule keeps its   */
/* own target from its own opening time" — but it's preserved here so an      */
/* operator can unstick the lifecycle when no live data is available at all.  */
/*                                                                            */
/* For routine per-schedule manual seeding (one schedule, fresh value), use   */
/* POST /api/admin/seed-market-from-manual-snapshot (singular) instead.       */
/*                                                                            */
/* The supplied marketCap becomes open_mc / target_mc on every market it      */
/* creates, so a wrong value will distort settlement outcomes.                */
/* ========================================================================== */
adminRouter.post("/seed-markets-from-manual-snapshot", async (req, res) => {
  const actor = req.header("x-admin-actor") ?? "admin";
  const body = req.body as { marketCap?: number; priceUsd?: number; source?: string };

  try {
    const marketCap = Number(body.marketCap);
    if (!Number.isFinite(marketCap) || marketCap <= 0) {
      throw new Error("invalid_market_cap");
    }
    const priceUsd =
      body.priceUsd != null && Number.isFinite(Number(body.priceUsd)) && Number(body.priceUsd) > 0
        ? Number(body.priceUsd)
        : undefined;

    console.warn(
      `[admin/manual-seed] EMERGENCY FALLBACK invoked.  ` +
        `mc=$${(marketCap / 1e6).toFixed(2)}M ` +
        `price=${priceUsd ?? "auto"} source=${body.source ?? "manual"}`,
    );

    // Build the synthetic snapshot AND cache it.  Caching means the next
    // automatic tick that runs while providers are still down will read
    // this back from oracle_snapshots and continue advancing the lifecycle
    // without further admin involvement.
    const snapshot = await buildManualSnapshot({
      marketCapUsd: marketCap,
      priceUsd,
      source: body.source,
    });

    const { results } = await ensureOneActivePerSchedule(snapshot);
    await logAction(
      actor,
      "seed_markets_from_manual_snapshot",
      { marketCap, priceUsd, source: body.source, results },
      "ok",
      null,
    );
    res.json({
      ok: true,
      // v19: response calls out the emergency-only nature so anyone reading
      // logs / curl output can't mistake this for the routine seed path.
      mode: "emergency_fallback_shared_snapshot",
      note:
        "Emergency fallback only — all empty schedules share this single " +
        "operator-supplied snapshot.  For per-schedule manual seeding, use " +
        "POST /api/admin/seed-market-from-manual-snapshot (singular).",
      snapshot: {
        marketCap: snapshot.marketCapUsd,
        priceUsd: snapshot.priceUsd,
        source: snapshot.source,
        fetchedAt: snapshot.fetchedAt.toISOString(),
      },
      results: results.map((r) => ({
        scheduleType: r.scheduleType,
        created: r.created,
        marketId: r.marketId,
        reason: r.reason,
      })),
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[admin/manual-seed] failed reason=${msg}`);
    await logAction(actor, "seed_markets_from_manual_snapshot", body, "error", msg);
    res.status(400).json({ error: "manual_seed_failed", message: msg });
  }
});

/* ========================================================================== */
/* POST /api/admin/seed-market-from-manual-snapshot   (v19, singular)         */
/* Body: {                                                                    */
/*   scheduleType: "15m" | "hourly" | "daily",                                */
/*   marketCap: number,                                                       */
/*   priceUsd?: number,                                                       */
/*   source?: string                                                          */
/* }                                                                          */
/*                                                                            */
/* Per-schedule manual seed.  Use when ONE schedule's slot is empty and you   */
/* want to give it a specific market cap (e.g., the value that was live at    */
/* its actual opening boundary, when the live providers missed it).  Other    */
/* schedules are NOT touched — this is the surgical alternative to the bulk   */
/* emergency endpoint above.                                                  */
/*                                                                            */
/* Returns 409 if the named schedule already has an active market.            */
/* ========================================================================== */
adminRouter.post("/seed-market-from-manual-snapshot", async (req, res) => {
  const actor = req.header("x-admin-actor") ?? "admin";
  const body = req.body as {
    scheduleType?: ScheduleType;
    marketCap?: number;
    priceUsd?: number;
    source?: string;
  };

  try {
    const scheduleType = body.scheduleType;
    if (scheduleType !== "15m" && scheduleType !== "hourly" && scheduleType !== "daily") {
      throw new Error("invalid_schedule_type");
    }
    const marketCap = Number(body.marketCap);
    if (!Number.isFinite(marketCap) || marketCap <= 0) {
      throw new Error("invalid_market_cap");
    }
    const priceUsd =
      body.priceUsd != null && Number.isFinite(Number(body.priceUsd)) && Number(body.priceUsd) > 0
        ? Number(body.priceUsd)
        : undefined;

    console.info(
      `[admin/seed-one] schedule=${scheduleType} ` +
        `mc=$${(marketCap / 1e6).toFixed(2)}M price=${priceUsd ?? "auto"} ` +
        `source=${body.source ?? "manual_admin"}`,
    );

    const snapshot = await buildManualSnapshot({
      marketCapUsd: marketCap,
      priceUsd,
      source: body.source ?? "manual_admin",
    });

    const result = await seedSingle(scheduleType, snapshot);
    await logAction(
      actor,
      "seed_market_from_manual_snapshot",
      { scheduleType, marketCap, priceUsd, source: body.source, result },
      "ok",
      null,
    );

    if (!result.created) {
      // Most common no-op: schedule already has an active market.  Caller
      // should void or wait for that one to settle before re-seeding.
      const status = result.reason === "already_active" ? 409 : 200;
      return res.status(status).json({
        ok: false,
        scheduleType,
        created: false,
        reason: result.reason,
        marketId: result.marketId,
      });
    }

    res.json({
      ok: true,
      scheduleType,
      created: true,
      marketId: result.marketId,
      snapshot: {
        marketCap: snapshot.marketCapUsd,
        priceUsd: snapshot.priceUsd,
        source: snapshot.source,
        fetchedAt: snapshot.fetchedAt.toISOString(),
      },
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[admin/seed-one] failed reason=${msg}`);
    await logAction(actor, "seed_market_from_manual_snapshot", body, "error", msg);
    res.status(400).json({ error: "manual_seed_failed", message: msg });
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
/* POST /api/admin/reconcile-escrow                                           */
/* v47 — find and recover orphaned on-chain SOL deposits.                     */
/* Walks recent SOL transfers TO the escrow authority and either creates a    */
/* matching position (if a tradable market matches) or queues a refund (if    */
/* market closed/voided/unmatched).  Idempotent — safe to run repeatedly.    */
/* Recommended cron schedule: every 1-2 minutes alongside tick + payouts.     */
/* ========================================================================== */
adminRouter.post("/reconcile-escrow", async (req, res) => {
  const actor = req.header("x-admin-actor") ?? "admin";
  const limit = Number((req.body as { limit?: number })?.limit ?? 50);
  try {
    const result = await reconcileEscrowDeposits({ limit });
    await logAction(actor, "reconcile_escrow", { limit }, "ok", null);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = (err as Error).message;
    await logAction(actor, "reconcile_escrow", { limit }, "error", msg);
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
