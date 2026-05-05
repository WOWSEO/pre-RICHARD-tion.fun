import { DexScreenerProvider } from "../providers/dexScreenerProvider";
import { GeckoTerminalProvider } from "../providers/geckoTerminalProvider";
import { TROLL } from "../config/troll";

export interface TrollMarketData {
  /** USD market cap (FDV displayed as MC, per Pump.fun convention) */
  marketCapUsd: number | null;
  priceUsd: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  source: "dexscreener" | "geckoterminal" | "none";
}

/**
 * Live $TROLL market snapshot.
 *
 * Tries DexScreener first (fastest, no auth, FDV in payload); falls back to
 * GeckoTerminal if DexScreener is rate-limited or returns no pairs.
 *
 * Pairs/pools are configured via env at build time:
 *   VITE_DEXSCREENER_PAIR_URL, VITE_GECKOTERMINAL_POOL_URL
 * If those are unset we still try by mint address.
 */
export async function getTrollMarketData(): Promise<TrollMarketData> {
  // The TROLL coin config carries the mint address used by both providers.
  // Env override path: VITE_TROLL_MINT can be wired into a custom CoinConfig later.
  if (!TROLL.mintAddress) {
    return {
      marketCapUsd: null,
      priceUsd: null,
      volume24hUsd: null,
      liquidityUsd: null,
      source: "none",
    };
  }

  // 1) DexScreener
  try {
    const ds = new DexScreenerProvider();
    const snap = await ds.fetchSnapshot(TROLL, new Date());
    if (snap.ok && snap.marketCapUsd != null) {
      return {
        marketCapUsd: snap.marketCapUsd,
        priceUsd: snap.priceUsd,
        volume24hUsd: snap.volume24hUsd,
        liquidityUsd: snap.liquidityUsd,
        source: "dexscreener",
      };
    }
  } catch {
    /* fallthrough */
  }

  // 2) GeckoTerminal
  try {
    const gt = new GeckoTerminalProvider();
    const snap = await gt.fetchSnapshot(TROLL, new Date());
    if (snap.ok && snap.marketCapUsd != null) {
      return {
        marketCapUsd: snap.marketCapUsd,
        priceUsd: snap.priceUsd,
        volume24hUsd: snap.volume24hUsd,
        liquidityUsd: snap.liquidityUsd,
        source: "geckoterminal",
      };
    }
  } catch {
    /* fallthrough */
  }

  return {
    marketCapUsd: null,
    priceUsd: null,
    volume24hUsd: null,
    liquidityUsd: null,
    source: "none",
  };
}

export function formatMC(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

export function formatPrice(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.0001) return `$${usd.toExponential(2)}`;
  if (usd < 1) return `$${usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${usd.toFixed(4)}`;
}
