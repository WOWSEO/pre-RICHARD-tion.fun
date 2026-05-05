/**
 * Single-shot live $TROLL MC / price snapshot used at market-open time.
 *
 * Used by the seeder (server/services/marketSeeder.ts) to take the opening
 * snapshot that becomes the higher/lower threshold for a freshly-created
 * market.  This is intentionally *not* the same code path as the brain's
 * settlement providers — the brain polls multiple sources during the close
 * window and computes a median; this is a simpler "give me a number now"
 * helper that the seeder calls when it's about to insert a row.
 *
 * Source priority:
 *   1. DexScreener pair API  (primary — same source the frontend MC card uses)
 *   2. GeckoTerminal         (fallback)
 *
 * Throws if neither succeeds.  Callers must treat that as "skip this seed
 * attempt" and try again on the next cron tick — we never want to create a
 * market with a fake or stale opening snapshot.
 */

import { TROLL } from "../../src/config/troll";

export interface LiveSnapshot {
  /** UI USD price per token, e.g. 0.000043 */
  priceUsd: number;
  /** USD market cap (FDV is treated as MC for this token) */
  marketCapUsd: number;
  /** When the snapshot was actually fetched */
  fetchedAt: Date;
  /** Which provider produced the value */
  source: "dexscreener" | "geckoterminal";
}

/* DexScreener pair — read from server env so server and client can be wired
 * to the same pair without duplicating the address.  Falls back to the same
 * default the frontend uses. */
function getPairAddress(): string {
  // Server-side preferred, then the VITE_ var if .env is shared, then default.
  const url =
    process.env.DEXSCREENER_PAIR_URL ??
    process.env.VITE_DEXSCREENER_PAIR_URL ??
    "https://dexscreener.com/solana/4w2cysotx6czaugmmwg13hdpy4qemg2czekyeqyk9ama";
  const tail = url.split("/").filter(Boolean).pop();
  return tail || "4w2cysotx6czaugmmwg13hdpy4qemg2czekyeqyk9ama";
}

async function fromDexScreener(): Promise<LiveSnapshot> {
  const pair = getPairAddress();
  const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${pair}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`dexscreener_${res.status}`);
  const data = (await res.json()) as {
    pair?: { priceUsd?: string | number; fdv?: number; marketCap?: number };
  };
  const priceUsd = Number(data.pair?.priceUsd);
  const mc = Number(data.pair?.fdv ?? data.pair?.marketCap);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error("dexscreener_no_price");
  if (!Number.isFinite(mc) || mc <= 0) throw new Error("dexscreener_no_mc");
  return {
    priceUsd,
    marketCapUsd: mc,
    fetchedAt: new Date(),
    source: "dexscreener",
  };
}

async function fromGeckoTerminal(): Promise<LiveSnapshot> {
  // GeckoTerminal token endpoint, by mint.  The brain provider already knows
  // how to parse this — we just need a single MC reading here.
  const mint = process.env.TROLL_MINT ?? TROLL.mintAddress;
  if (!mint) throw new Error("geckoterminal_no_mint");
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`;
  const res = await fetch(url, {
    headers: { accept: "application/json;version=20230302" },
  });
  if (!res.ok) throw new Error(`geckoterminal_${res.status}`);
  const data = (await res.json()) as {
    data?: {
      attributes?: {
        price_usd?: string | number;
        fdv_usd?: string | number;
        market_cap_usd?: string | number;
      };
    };
  };
  const a = data.data?.attributes ?? {};
  const priceUsd = Number(a.price_usd);
  const mc = Number(a.fdv_usd ?? a.market_cap_usd);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error("geckoterminal_no_price");
  if (!Number.isFinite(mc) || mc <= 0) throw new Error("geckoterminal_no_mc");
  return {
    priceUsd,
    marketCapUsd: mc,
    fetchedAt: new Date(),
    source: "geckoterminal",
  };
}

/**
 * Take a fresh snapshot.  Tries DexScreener first, falls back to GeckoTerminal.
 * Throws an aggregated error if both fail.
 */
export async function fetchTrollSnapshot(): Promise<LiveSnapshot> {
  const errors: string[] = [];

  try {
    return await fromDexScreener();
  } catch (err) {
    errors.push(`dexscreener: ${(err as Error).message}`);
  }

  try {
    return await fromGeckoTerminal();
  } catch (err) {
    errors.push(`geckoterminal: ${(err as Error).message}`);
  }

  throw new Error(`live_snapshot_failed: ${errors.join(" | ")}`);
}
