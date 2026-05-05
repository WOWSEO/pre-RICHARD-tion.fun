#!/usr/bin/env tsx
import "dotenv/config";
import { loadEnv } from "../env";
import { ensureOneActivePerSchedule } from "../services/marketSeeder";

/**
 * `npm run seed:markets` — one-shot seeder.
 *
 * Walks all 3 schedule types and creates a market for any empty slot.
 * Exits 0 on success (even if all 3 slots were already filled — that's a no-op,
 * not an error).  Exits 1 only if the seeder code itself threw.
 *
 * Wire this to cron — every 30s is comfortable.  In normal operation the
 * settlement orchestrator hands off to the seeder immediately after persisting
 * a market's terminal state, so cron is just a safety net for missed handoffs
 * and for cold-starting an empty database.
 */
async function main(): Promise<void> {
  // Boot-time env validation — fail fast if config is wrong.
  loadEnv();

  console.log(`[seed:markets] tick ${new Date().toISOString()}`);
  const { results } = await ensureOneActivePerSchedule();
  for (const r of results) {
    if (r.created) {
      const mc = r.snapshot
        ? `$${(r.snapshot.marketCapUsd / 1_000_000).toFixed(2)}M (via ${r.snapshot.source})`
        : "n/a";
      console.log(`  + ${r.scheduleType}: created ${r.marketId}, open MC=${mc}`);
    } else {
      console.log(`  · ${r.scheduleType}: ${r.reason ?? "no-op"}`);
    }
  }
}

main().catch((err) => {
  console.error("[seed:markets] fatal", err);
  process.exit(1);
});
