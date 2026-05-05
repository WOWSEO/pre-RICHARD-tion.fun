#!/usr/bin/env tsx
import "dotenv/config";
import { loadEnv } from "../env";
import { tickMarkets } from "../services/tickService";

/**
 * `npm run tick:markets` — one-shot lifecycle tick.
 *
 * Calls the SAME tickMarkets() function as POST /api/admin/tick-markets, so
 * local dev and production behave identically.  Useful for:
 *
 *   - Manual fixup when the production cron has missed a tick
 *     (e.g., Render cron service was paused).
 *   - Local dev — push the lifecycle forward without waiting for a real
 *     close_at.  Combine with `UPDATE markets SET close_at=now()` in psql
 *     to force a settle in seconds.
 *   - As an alternative to the HTTP cron — operators who don't want to
 *     expose admin endpoints to the internet can run this from a private
 *     cron host and avoid the curl path entirely.
 *
 * Exit codes:
 *   0  — tick completed (even if individual markets had errors).  The next
 *        cron invocation will retry them.
 *   1  — tick threw before completing (Supabase down, env not loaded, ...).
 */
async function main(): Promise<void> {
  loadEnv(); // fail-fast on bad env

  const result = await tickMarkets();

  // Pretty-print summary for cron logs.
  console.log("[tick:markets] summary:");
  console.log(`  settled ${result.settled.length}:`);
  for (const s of result.settled) {
    console.log(
      `    - ${s.marketId} (${s.scheduleType}) → ${s.outcome}` +
        (s.voidReason ? ` (${s.voidReason})` : "") +
        (s.nextMarketId ? ` → next=${s.nextMarketId}` : "") +
        (s.nextSeedReason ? ` (next_seed: ${s.nextSeedReason})` : ""),
    );
  }
  console.log(`  created ${result.created.length}:`);
  for (const c of result.created) {
    const mc = c.openMc != null ? `$${(c.openMc / 1e6).toFixed(2)}M` : "—";
    console.log(
      `    + ${c.marketId} (${c.scheduleType}) openMc=${mc}` +
        (c.openSnapshotSource ? ` via ${c.openSnapshotSource}` : "") +
        (c.closeAt ? ` closes=${c.closeAt}` : ""),
    );
  }
  console.log(`  active 3-slot state:`);
  for (const a of result.active) {
    if (a.marketId) {
      console.log(`    · ${a.scheduleType}: ${a.marketId} status=${a.status} closes=${a.closeAt}`);
    } else {
      console.log(`    · ${a.scheduleType}: <empty>`);
    }
  }
  if (result.skipped.length > 0) {
    console.log(`  skipped ${result.skipped.length}:`);
    for (const s of result.skipped) console.log(`    · ${s.marketId}: ${s.reason}`);
  }
  if (result.errors.length > 0) {
    console.log(`  errors ${result.errors.length}:`);
    for (const e of result.errors) console.log(`    ! ${e.marketId}: ${e.error}`);
  }
  console.log(`  elapsedMs=${result.elapsedMs}`);
}

main().catch((err) => {
  console.error("[tick:markets] fatal", err);
  process.exit(1);
});
