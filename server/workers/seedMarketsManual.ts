#!/usr/bin/env tsx
import "dotenv/config";
import { loadEnv } from "../env";
import { buildManualSnapshot } from "../services/marketSnapshot";
import { ensureOneActivePerSchedule } from "../services/marketSeeder";

/**
 * `npm run seed:markets:manual` — escape-hatch market seeder.
 *
 * Same logic as POST /api/admin/seed-markets-from-manual-snapshot, run from
 * the local CLI.  Use when DexScreener / GeckoTerminal are both rate-limited
 * AND the operator can't / doesn't want to call the admin endpoint over HTTP.
 *
 * Usage:
 *
 *   npm run seed:markets:manual -- --mc 42500000
 *   npm run seed:markets:manual -- --mc 42500000 --price 0.0000425 --source coingecko
 *
 *   Or via env (handy for one-line shell pipelines):
 *
 *   MANUAL_MC=42500000 npm run seed:markets:manual
 *   MANUAL_MC=42500000 MANUAL_PRICE=0.0000425 MANUAL_SOURCE=coingecko \
 *     npm run seed:markets:manual
 *
 * The manual snapshot is also written to oracle_snapshots so subsequent
 * automatic ticks have a fallback while the providers stay rate-limited.
 *
 * Exits 0 on success (with a printed summary of which slots were filled),
 * 1 on argument or env error, 2 on Supabase / network error.
 */

interface ManualArgs {
  marketCap: number;
  priceUsd?: number;
  source?: string;
}

function parseArgs(argv: string[]): ManualArgs | { error: string } {
  // Accept both `--mc <n>` and `--mc=<n>` forms.
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        args.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const val = argv[i + 1];
        if (val && !val.startsWith("--")) {
          args.set(a.slice(2), val);
          i++;
        } else {
          args.set(a.slice(2), "true");
        }
      }
    }
  }

  const mcRaw = args.get("mc") ?? process.env.MANUAL_MC ?? "";
  const priceRaw = args.get("price") ?? process.env.MANUAL_PRICE ?? "";
  const source = args.get("source") ?? process.env.MANUAL_SOURCE ?? undefined;

  const marketCap = Number(mcRaw);
  if (!Number.isFinite(marketCap) || marketCap <= 0) {
    return {
      error:
        `invalid market cap: "${mcRaw}".  ` +
        `Pass --mc <number> or set MANUAL_MC.  ` +
        `Example: npm run seed:markets:manual -- --mc 42500000`,
    };
  }
  let priceUsd: number | undefined;
  if (priceRaw.length > 0) {
    const p = Number(priceRaw);
    if (!Number.isFinite(p) || p <= 0) {
      return { error: `invalid price: "${priceRaw}"` };
    }
    priceUsd = p;
  }
  return { marketCap, priceUsd, source };
}

async function main(): Promise<void> {
  loadEnv();

  const parsed = parseArgs(process.argv);
  if ("error" in parsed) {
    console.error(`[seed:markets:manual] ${parsed.error}`);
    process.exit(1);
  }

  console.log(
    `[seed:markets:manual] mc=$${(parsed.marketCap / 1e6).toFixed(2)}M ` +
      `price=${parsed.priceUsd ?? "auto"} source=${parsed.source ?? "manual"}`,
  );

  const snapshot = await buildManualSnapshot({
    marketCapUsd: parsed.marketCap,
    priceUsd: parsed.priceUsd,
    source: parsed.source,
  });

  console.log(
    `[seed:markets:manual] snapshot built source=${snapshot.source} ` +
      `fetchedAt=${snapshot.fetchedAt.toISOString()}, also written to oracle_snapshots`,
  );

  const { results } = await ensureOneActivePerSchedule(snapshot);
  console.log("[seed:markets:manual] results:");
  for (const r of results) {
    if (r.created) {
      console.log(`  + ${r.scheduleType}: created ${r.marketId}`);
    } else {
      console.log(`  · ${r.scheduleType}: ${r.reason ?? "no-op"}`);
    }
  }
}

main().catch((err) => {
  console.error("[seed:markets:manual] fatal", err);
  process.exit(2);
});
