/**
 * Live SOL/USD price feed.
 *
 * Source: Jupiter price API v2 (https://price.jup.ag/v6/price?ids=SOL).
 * It returns USD price for any Solana token id; we use it for SOL itself.
 *
 * Caching:
 *   30-second TTL.  At a 1-minute tick cadence this means at most 2 fetches
 *   per minute even under heavy use.  Way under Jupiter's rate limit (no
 *   limit listed for the public endpoint, but we want to be polite).
 *
 * Fallback chain:
 *   1. Live Jupiter call
 *   2. In-memory cache from last successful call (up to 5 minutes old)
 *   3. Throw — caller should surface "price_feed_unavailable" to the user.
 *      We DO NOT silently use a stale price > 5 min old because that would
 *      let us mis-quote bets during a feed outage.
 *
 * v23 currency conversion math (lives in currencyConverter.ts):
 *   solEquivalent = trollAmount * trollPriceUsd / solPriceUsd
 *
 * trollPriceUsd comes from the same DexScreener snapshot that drives the
 * market's open_mc.  solPriceUsd comes from this module.
 */

interface CachedPrice {
  priceUsd: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 30_000;
const STALE_FALLBACK_TTL_MS = 5 * 60 * 1000; // 5 min

const _cache: { latest: CachedPrice | null } = { latest: null };

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_PRICE_URL = `https://price.jup.ag/v6/price?ids=${SOL_MINT}`;

export interface SolPriceResult {
  priceUsd: number;
  /** Whether the value came from the live API or the in-memory fallback. */
  source: "live" | "cache_stale";
  /** Age of the value in milliseconds (0 for fresh live calls). */
  ageMs: number;
}

export async function fetchSolPriceUsd(): Promise<SolPriceResult> {
  const now = Date.now();
  // Fresh-cache hit
  if (_cache.latest && now - _cache.latest.fetchedAt < CACHE_TTL_MS) {
    return {
      priceUsd: _cache.latest.priceUsd,
      source: "live",
      ageMs: now - _cache.latest.fetchedAt,
    };
  }

  // Live fetch
  try {
    const r = await fetch(JUPITER_PRICE_URL);
    if (!r.ok) throw new Error(`jupiter_http_${r.status}`);
    const json = (await r.json()) as {
      data?: Record<string, { id: string; price: number | string }>;
    };
    const entry = json.data?.[SOL_MINT];
    if (!entry || entry.price == null) throw new Error("jupiter_no_sol_price");
    const priceUsd = Number(entry.price);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new Error("jupiter_invalid_price");
    }
    _cache.latest = { priceUsd, fetchedAt: now };
    return { priceUsd, source: "live", ageMs: 0 };
  } catch (err) {
    // Stale-cache fallback — only if recent enough
    if (
      _cache.latest &&
      now - _cache.latest.fetchedAt < STALE_FALLBACK_TTL_MS
    ) {
      console.warn(
        `[solPrice] live-fetch-failed reason=${(err as Error).message} ` +
          `using-stale ageMs=${now - _cache.latest.fetchedAt}`,
      );
      return {
        priceUsd: _cache.latest.priceUsd,
        source: "cache_stale",
        ageMs: now - _cache.latest.fetchedAt,
      };
    }
    // No usable value — propagate so the caller can reject the user request.
    console.error(
      `[solPrice] price-feed-unavailable reason=${(err as Error).message}`,
    );
    throw new Error(`sol_price_unavailable: ${(err as Error).message}`);
  }
}
