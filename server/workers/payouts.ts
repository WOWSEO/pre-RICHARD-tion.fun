#!/usr/bin/env tsx
import "dotenv/config";
import { loadEnv } from "../env";
import { runPendingWithdrawals } from "../services/payoutEngine";

/**
 * `npm run payouts:run` — one-shot pending-withdrawal processor.
 *
 * Walks every escrow_withdrawal with status='pending' and tries to send each
 * via sendWithdrawal().  The atomic CAS inside sendWithdrawal makes this safe
 * to run concurrently with admin /api/admin/payouts/run and with user-driven
 * /api/positions/withdrawals/:id/claim — only one process can claim each row.
 *
 * Wire to cron — every 30-60s.  Together with the user-driven /claim endpoint
 * and the admin /payouts/run endpoint, this gives operators three independent
 * paths from "settled position" → "$TROLL in winner's wallet":
 *
 *   1. User clicks "Claim" on the per-market or /claims page.
 *   2. This cron sweeps through everything pending periodically.
 *   3. Admin manually fires /api/admin/payouts/run from the admin console.
 *
 * All three paths converge on the same sendWithdrawal() — there is one place
 * where SPL transfers happen, and exactly one row at a time can be in flight.
 */
async function main(): Promise<void> {
  loadEnv(); // fail-fast on bad env

  const startedAt = Date.now();
  console.log(`[payouts:run] tick ${new Date().toISOString()}`);

  // Process up to 100 pending withdrawals per tick.  At a 60s cron, this
  // gives a sustained throughput of ~100/min which is more than enough for
  // the expected market volume.
  const result = await runPendingWithdrawals(100);
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[payouts:run] done processed=${result.processed} skipped=${result.skipped} elapsedMs=${elapsedMs}`,
  );
}

main().catch((err) => {
  console.error("[payouts:run] fatal", err);
  process.exit(1);
});
