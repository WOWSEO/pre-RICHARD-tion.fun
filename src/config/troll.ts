import type { CoinConfig } from "../market/marketTypes";

/**
 * Single hardcoded coin for the brain POC.
 * All source URLs are placeholders — provider stubs accept overrides.
 * Replace mintAddress with the real $TROLL mint when known.
 */
export const TROLL: CoinConfig = {
  symbol: "TROLL",
  name: "Troll Cat",
  mintAddress: "TROLLmint11111111111111111111111111111111111",
  decimals: 6,
  pumpfunUrl: "https://pump.fun/coin/TROLLmint11111111111111111111111111111111111",
  dexscreenerSource:
    "https://api.dexscreener.com/token-pairs/v1/solana/TROLLmint11111111111111111111111111111111111",
  geckoterminalSource:
    "https://api.geckoterminal.com/api/v2/networks/solana/tokens/TROLLmint11111111111111111111111111111111111",
  heliusSource: "https://mainnet.helius-rpc.com/?api-key=PLACEHOLDER",
  active: true,
  minLiquidityUsd: 25_000,
  minVolume24hUsd: 10_000,
};
