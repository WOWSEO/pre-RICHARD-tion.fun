import { useEffect, useState } from "react";
import { api, type CoinWire } from "../services/apiClient";

/**
 * v54 — Coin registry hook.
 *
 * Fetches GET /api/coins on mount and caches the result for the lifetime of
 * the component tree.  Refreshes on intervalMs (default 60s — the registry
 * almost never changes, so polling is mostly belt-and-braces in case an
 * operator activates a new coin without a frontend redeploy).
 *
 * Returns is_active=true coins only, sorted by displayOrder.
 *
 * Fallback: if the server returns nothing (registry table empty), the server
 * itself falls back to the hardcoded COINS list — see server/routes/coins.ts.
 * From the client's perspective we always get a non-empty list, so we don't
 * need a separate "no coins available" branch in the UI.
 */
export function useCoins(intervalMs = 60_000): {
  coins: CoinWire[];
  loading: boolean;
  error: string | null;
} {
  const [coins, setCoins] = useState<CoinWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      try {
        const data = await api.listCoins();
        if (cancelled) return;
        // is_active filter is already applied server-side, but defend against
        // future schema changes by re-asserting client-side.
        const active = data.coins
          .filter((c) => c.isActive)
          .sort((a, b) => a.displayOrder - b.displayOrder);
        setCoins(active);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load coins");
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(run, intervalMs);
        }
      }
    };
    run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);

  return { coins, loading, error };
}

/**
 * Find a coin by mint address.  Convenient for dehydrating a `?coin=<mint>`
 * URL param into a coin object.
 */
export function findCoin(coins: CoinWire[], mint: string | null): CoinWire | null {
  if (!mint) return null;
  return coins.find((c) => c.mint === mint) ?? null;
}

/**
 * Find a coin by symbol (case-insensitive).  Useful for legacy URLs that
 * used `?coin=USDUC` instead of the mint.
 */
export function findCoinBySymbol(coins: CoinWire[], symbol: string | null): CoinWire | null {
  if (!symbol) return null;
  const s = symbol.toUpperCase();
  return coins.find((c) => c.symbol.toUpperCase() === s) ?? null;
}
