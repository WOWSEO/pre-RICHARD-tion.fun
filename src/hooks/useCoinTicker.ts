import { useEffect, useMemo, useState } from "react";
import type { CoinWire } from "../services/apiClient";

export interface CoinTicker {
  priceUsd: number | null;
  marketCapUsd: number | null;
  updatedAt: Date | null;
  error: string | null;
}

const emptyTicker: CoinTicker = {
  priceUsd: null,
  marketCapUsd: null,
  updatedAt: null,
  error: null,
};

/**
 * Extract the dexscreener pair address from any coin's pair URL.
 *
 * We accept either:
 *   - https://dexscreener.com/solana/<pairAddress>           (browser URL)
 *   - https://api.dexscreener.com/.../<mint>                 (API URL — falls
 *     through; same shape, last segment is the mint, not pair, but the
 *     pairs endpoint forgives that and returns the same payload either way
 *     for a single-pair token)
 *
 * We strip query strings and trailing slashes before grabbing the last
 * non-empty segment.
 */
function extractPairOrMint(url: string): string | null {
  if (!url) return null;
  const clean = url.split("?")[0]!.replace(/\/+$/, "");
  const tail = clean.split("/").filter(Boolean).pop();
  return tail ?? null;
}

/**
 * v54 — Live ticker for any coin in the registry.
 *
 * Drop-in replacement for the v0–v53 single-coin useTrollTicker.  Polls
 * DexScreener's pairs endpoint on a 2s cadence and exposes the same shape
 * `{ priceUsd, marketCapUsd, updatedAt, error }` so the existing MC card
 * and float cards keep working without changes.
 *
 * coin === null → returns the empty ticker (loading state).  Useful while
 * the registry is still fetching on first mount.
 */
export function useCoinTicker(coin: CoinWire | null, intervalMs = 2_000): CoinTicker {
  const [ticker, setTicker] = useState<CoinTicker>(emptyTicker);

  // Build the API URL whenever coin changes.  Memoised so the effect below
  // doesn't churn on every render.
  const apiUrl = useMemo(() => {
    if (!coin) return null;
    const pair = extractPairOrMint(coin.dexscreenerEmbedUrl) ?? extractPairOrMint(coin.dexscreenerPairUrl);
    if (!pair) return null;
    return `https://api.dexscreener.com/latest/dex/pairs/solana/${pair}`;
  }, [coin]);

  useEffect(() => {
    if (!apiUrl) {
      setTicker(emptyTicker);
      return;
    }
    let cancelled = false;

    async function loadTicker() {
      try {
        const response = await fetch(apiUrl!, { cache: "no-store" });
        if (!response.ok) throw new Error(`DexScreener ${response.status}`);
        const data = await response.json();
        // Shape: { pair: { priceUsd, fdv, marketCap, ... } } | { pairs: [...] }
        // Some token pages return an array under .pairs; handle both.
        const pair = data?.pair ?? data?.pairs?.[0] ?? null;
        if (!pair) throw new Error("No pair data");
        const priceUsd = Number(pair?.priceUsd);
        const marketCapUsd = Number(pair?.fdv ?? pair?.marketCap);

        if (!Number.isFinite(priceUsd) || !Number.isFinite(marketCapUsd)) {
          throw new Error("Missing live price data");
        }

        if (!cancelled) {
          setTicker({ priceUsd, marketCapUsd, updatedAt: new Date(), error: null });
        }
      } catch (error) {
        if (!cancelled) {
          setTicker((current) => ({
            ...current,
            error: error instanceof Error ? error.message : "Price feed unavailable",
          }));
        }
      }
    }

    // Reset to empty ticker on coin switch so the UI doesn't briefly show the
    // old coin's MC under the new coin's logo while the first fetch is in
    // flight.  The fetch below will populate within ~250ms.
    setTicker(emptyTicker);

    loadTicker();
    const timer = window.setInterval(loadTicker, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [apiUrl, intervalMs]);

  return ticker;
}
