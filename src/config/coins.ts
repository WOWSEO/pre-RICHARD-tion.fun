import type { CoinConfig } from "../market/marketTypes";

/**
 * v53 — Coin registry.
 *
 * Hardcoded fallback list of supported coins.  At runtime the server
 * authoritative source is the `supported_coins` table in Supabase
 * (loaded by server/services/coinRegistry.ts).  This file mirrors the
 * production seed so:
 *   - tests don't need a database
 *   - the frontend can compile against a static type
 *   - a fresh deploy with an empty table still has 3 working markets
 *
 * To add a coin: insert a row in supported_coins via SQL (see migration
 * 005_multi_coin.sql for the seed pattern), then optionally append to
 * this list for offline parity.
 */

/**
 * TROLL — the original.
 *
 * Public addresses + chart URLs.  No secrets.  Helius source intentionally
 * carries the literal string "PLACEHOLDER" — the brain's GeckoTerminal
 * provider is the actual MC source; helius is reserved for future
 * on-chain price-curve work.
 */
export const TROLL: CoinConfig = {
  symbol: "TROLL",
  name: "Troll Cat",
  mintAddress: "5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2",
  decimals: 6,
  pumpfunUrl: "https://pump.fun/coin/5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2",
  dexscreenerSource:
    "https://api.dexscreener.com/token-pairs/v1/solana/5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2",
  geckoterminalSource:
    "https://api.geckoterminal.com/api/v2/networks/solana/tokens/5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2",
  heliusSource: "https://mainnet.helius-rpc.com/?api-key=PLACEHOLDER",
  active: true,
  minLiquidityUsd: 25_000,
  minVolume24hUsd: 10_000,
};

/**
 * USDUC — Unstable Coin.  Pump.fun launch, ~$25M MC, ~$908K liquidity.
 */
export const USDUC: CoinConfig = {
  symbol: "USDUC",
  name: "Unstable Coin",
  mintAddress: "CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump",
  decimals: 6,
  pumpfunUrl: "https://pump.fun/coin/CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump",
  dexscreenerSource:
    "https://api.dexscreener.com/token-pairs/v1/solana/CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump",
  geckoterminalSource:
    "https://api.geckoterminal.com/api/v2/networks/solana/tokens/CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump",
  heliusSource: "https://mainnet.helius-rpc.com/?api-key=PLACEHOLDER",
  active: true,
  minLiquidityUsd: 25_000,
  minVolume24hUsd: 10_000,
  // v54.5 — moderate liquidity, 5% disagreement tolerance.
  sourceDisagreementThreshold: 0.05,
};

/**
 * BUTT — Buttcoin.  Fartcoin-dev memecoin, ~$13M MC, ~$649K liquidity.
 */
export const BUTT: CoinConfig = {
  symbol: "BUTT",
  name: "Buttcoin",
  mintAddress: "Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump",
  decimals: 6,
  pumpfunUrl: "https://pump.fun/coin/Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump",
  dexscreenerSource:
    "https://api.dexscreener.com/token-pairs/v1/solana/Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump",
  geckoterminalSource:
    "https://api.geckoterminal.com/api/v2/networks/solana/tokens/Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump",
  heliusSource: "https://mainnet.helius-rpc.com/?api-key=PLACEHOLDER",
  active: true,
  minLiquidityUsd: 25_000,
  minVolume24hUsd: 10_000,
  // v54.5 — very low liquidity ($13K), needs wide disagreement tolerance
  // so DexScreener and GeckoTerminal price snapshots can settle.  Without
  // this, every BUTT market voids with `source_disagreement` (see Day 3
  // diagnosis: 4 of 4 closed BUTT 15m markets voided this way).
  sourceDisagreementThreshold: 0.15,
};

/**
 * HANTA — Hantavirus.  Pump.fun memecoin.  Added v54.6.  Liquidity assumed
 * low until measured; 15% threshold matches BUTT until we have data.
 */
export const HANTA: CoinConfig = {
  symbol: "HANTA",
  name: "Hantavirus",
  mintAddress: "2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y",
  decimals: 6,
  pumpfunUrl: "https://pump.fun/coin/2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y",
  dexscreenerSource:
    "https://api.dexscreener.com/token-pairs/v1/solana/2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y",
  geckoterminalSource:
    "https://api.geckoterminal.com/api/v2/networks/solana/tokens/2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y",
  heliusSource: "https://mainnet.helius-rpc.com/?api-key=PLACEHOLDER",
  active: true,
  minLiquidityUsd: 25_000,
  minVolume24hUsd: 10_000,
  sourceDisagreementThreshold: 0.15,
};

/**
 * Static fallback registry, in display order.  TROLL first, then USDUC, then BUTT.
 * Server prefers the DB; this is the offline / fresh-install fallback.
 */
/**
 * Static fallback registry, in display order.  v54.7: HANTA leads as the
 * default coin, followed by TROLL/USDUC/BUTT.  Server prefers the DB
 * (supported_coins.display_order); this is the offline / fresh-install
 * fallback and matches the production seed.
 */
export const COINS: CoinConfig[] = [HANTA, TROLL, USDUC, BUTT];

/** Lookup by mint.  Returns undefined for unknown mints. */
export function findCoinByMint(mint: string): CoinConfig | undefined {
  return COINS.find((c) => c.mintAddress === mint);
}

/** Lookup by symbol (case-insensitive). */
export function findCoinBySymbol(symbol: string): CoinConfig | undefined {
  const s = symbol.toUpperCase();
  return COINS.find((c) => c.symbol.toUpperCase() === s);
}

/** Default coin if no coin specified.  Stable across the app.
 *  v54.7: switched from TROLL to HANTA so HANTA is the landing-page default. */
export const DEFAULT_COIN: CoinConfig = HANTA;
