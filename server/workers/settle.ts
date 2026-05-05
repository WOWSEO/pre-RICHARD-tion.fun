/**
 * Settlement worker entry point.
 *
 * Run with `npm run settle`. Designed to be triggered by an external cron
 * (e.g. `* * * * * cd /app && /usr/bin/npm run settle >> /var/log/settle.log 2>&1`).
 *
 * Steps every invocation:
 *   1. Find every market past close window and not yet settled
 *   2. Settle each one — collects oracle snapshots, resolves outcome, persists audit
 *   3. Process pending escrow_withdrawals — sends SPL transfers from escrow back to users
 *
 * Idempotent at every step. A second invocation in the same minute is a no-op
 * (markets already terminal are skipped, withdrawals already sent are skipped).
 */
import { settleDueMarkets } from "../services/settlementOrchestrator";
import { runPendingWithdrawals } from "../services/payoutEngine";
import { loadEnv } from "../env";

async function main() {
  loadEnv();
  const t0 = Date.now();
  console.log("[settle] starting at", new Date().toISOString());

  let settleResult: Awaited<ReturnType<typeof settleDueMarkets>>;
  try {
    settleResult = await settleDueMarkets();
    console.log(
      `[settle] markets settled=${settleResult.settled.length} skipped=${settleResult.skipped.length} errors=${settleResult.errors.length}`,
    );
    if (settleResult.errors.length > 0) {
      for (const e of settleResult.errors) {
        console.error(`[settle] ${e.id}: ${e.error}`);
      }
    }
  } catch (err) {
    console.error("[settle] settleDueMarkets threw", err);
    process.exitCode = 1;
    return;
  }

  try {
    const pay = await runPendingWithdrawals(50);
    console.log(`[settle] payouts processed=${pay.processed}`);
  } catch (err) {
    console.error("[settle] runPendingWithdrawals threw", err);
    process.exitCode = 1;
    return;
  }

  console.log(`[settle] done in ${Date.now() - t0}ms`);
}

main().catch((err) => {
  console.error("[settle] fatal", err);
  process.exit(1);
});
