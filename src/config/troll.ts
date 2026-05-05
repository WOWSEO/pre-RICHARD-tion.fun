import type { CoinConfig } from "../market/marketTypes";

/**
 * Single hardcoded coin for the brain.
 *
 * mintAddress is the canonical default.  At runtime, TROLL_MINT (server) and
 * VITE_TROLL_MINT (client) env vars take precedence — see server/services/
 * marketSnapshot.ts and src/services/trollBalance.ts.  Setting the real mint
 * here ensures any code path that doesn't read env still works correctly
 * (notably the brain's GeckoTerminal provider in src/providers/).
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
