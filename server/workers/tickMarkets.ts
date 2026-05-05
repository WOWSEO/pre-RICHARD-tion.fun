#!/usr/bin/env tsx
import "dotenv/config";
import { loadEnv } from "../env";
import { tickMarkets } from "../services/tickService";

/**
 * Local/cron market lifecycle runner.
 *
 * Usage:
 *   npm run tick:markets
 *
 * This runs the same lifecycle logic as POST /api/admin/tick-markets:
 * - settle expired markets
 * - create missing 15m/hourly/daily markets
 * - use live oracle snapshot or recent cached/manual snapshot fallback
 */
async function main(): Promise<void> {
  loadEnv();
  const result = await tickMarkets();
  console.log(JSON.stringify(result, null, 2));

  // Non-fatal lifecycle errors should be visible to CI/cron operators.
  // Exit 0 if there was partial progress, but exit 1 if nothing active exists
  // and errors explain why no markets could be created.
  const activeCount = result.active.filter((m) => m.marketId).length;
  if (activeCount === 0 && result.errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[tick:markets] fatal", err);
  process.exit(2);
});
