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
 * Build the DexScreener API URLs we'll try in order.
 *
 * Primary: /token-pairs/v1/solana/{mint} — universal, accepts any coin's
 * mint address, returns a list of pairs sorted by liquidity.  Same endpoint
 * the server uses, so frontend MC matches server MC.
 *
 * Fallback: /latest/dex/pairs/solana/{pair} — kept for when the embed URL
 * has an explicit pair address, in case the token-pairs endpoint hiccups.
 */
function buildDexUrls(coin: CoinWire): { tokenPairsUrl: string; pairUrl: string | null } {
  const tokenPairsUrl = `https://api.dexscreener.com/token-pairs/v1/solana/${coin.mint}`;
  const tail =
    extractPairOrMint(coin.dexscreenerEmbedUrl) ??
    extractPairOrMint(coin.dexscreenerPairUrl);
  const pairUrl = tail ? `https://api.dexscreener.com/latest/dex/pairs/solana/${tail}` : null;
  return { tokenPairsUrl, pairUrl };
}

/**
 * v54 — Live ticker for any coin in the registry.
 *
 * Drop-in replacement for the v0–v53 single-coin useTrollTicker.  Polls
 * DexScreener on a 2s cadence and exposes the same shape `{ priceUsd,
 * marketCapUsd, updatedAt, error }` so the existing MC card and float
 * cards keep working without changes.
 *
 * coin === null → returns the empty ticker (loading state).  Useful while
 * the registry is still fetching on first mount.
 */
export function useCoinTicker(coin: CoinWire | null, intervalMs = 2_000): CoinTicker {
  const [ticker, setTicker] = useState<CoinTicker>(emptyTicker);

  // Build the URLs whenever coin changes.  Memoised so the effect below
  // doesn't churn on every render.
  const urls = useMemo(() => (coin ? buildDexUrls(coin) : null), [coin]);

  useEffect(() => {
    if (!urls) {
      setTicker(emptyTicker);
      return;
    }
    let cancelled = false;

    async function loadTicker() {
      // Shape of the per-pair element returned by either DexScreener
      // endpoint.  Both `/token-pairs/v1/...` and `/latest/dex/pairs/...`
      // return objects with at least these fields when they have data.
      type DexPair = {
        priceUsd?: string | number;
        fdv?: number;
        marketCap?: number;
        liquidity?: { usd?: number };
      };

      // Try token-pairs first (mint-based, universal).
      try {
        const response = await fetch(urls!.tokenPairsUrl, { cache: "no-store" });
        if (response.ok) {
          const data = await response.json();
          // /token-pairs/v1/... returns an array of pairs; pick the one
          // with the highest USD liquidity (= same canonical pair the
          // server uses for its own snapshots).
          const pairs: DexPair[] = Array.isArray(data) ? data : data?.pairs ?? [];
          if (pairs.length > 0) {
            const canonical = [...pairs].sort(
              (a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0),
            )[0]!;
            const priceUsd = Number(canonical?.priceUsd);
            const marketCapUsd = Number(canonical?.fdv ?? canonical?.marketCap);
            if (Number.isFinite(priceUsd) && Number.isFinite(marketCapUsd)) {
              if (!cancelled) {
                setTicker({ priceUsd, marketCapUsd, updatedAt: new Date(), error: null });
              }
              return;
            }
          }
        }
      } catch {
        // fall through to pair-URL fallback
      }

      // Fallback: pair-URL endpoint (works only if the registry has an
      // actual pair address in dexscreenerEmbedUrl).
      if (!urls!.pairUrl) {
        if (!cancelled) {
          setTicker((current) => ({ ...current, error: "no_pair_data" }));
        }
        return;
      }
      try {
        const response = await fetch(urls!.pairUrl, { cache: "no-store" });
        if (!response.ok) throw new Error(`DexScreener ${response.status}`);
        const data = await response.json();
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
    // flight.
    setTicker(emptyTicker);

    loadTicker();
    const timer = window.setInterval(loadTicker, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [urls, intervalMs]);

  return ticker;
}
