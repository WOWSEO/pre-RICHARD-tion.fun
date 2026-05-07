/**
 * Live SOL/USD price feed.  v35 — multi-provider.
 *
 * v23 used Jupiter's price.jup.ag/v6 endpoint, which Jupiter retired
 * in late 2024.  After that change, every SOL bet on the live site
 * died with `price_feed_unavailable` because the live fetch threw and
 * (for first-call requests) there was no in-memory cache to fall back
 * to.  v35 fixes this with a dual-provider chain:
 *
 *   1. Jupiter Lite price API (https://lite-api.jup.ag/price/v3)
 *      — modern Jupiter endpoint, free, no auth, same data source
 *   2. CoinGecko simple-price API
 *      — independent backup so a Jupiter outage doesn't block bets
 *   3. In-memory stale cache (up to 5 min old)
 *   4. Throw — caller surfaces "price_feed_unavailable" to the UI
 *
 * 30-second fresh-cache TTL is unchanged from v23.
 */

interface CachedPrice {
  priceUsd: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 30_000;
const STALE_FALLBACK_TTL_MS = 5 * 60 * 1000; // 5 min

const _cache: { latest: CachedPrice | null } = { latest: null };

const SOL_MINT = "So11111111111111111111111111111111111111112";

/* Jupiter Lite — modern replacement for the retired price.jup.ag/v6.
 * Response shape: { "<mint>": { "usdPrice": number, ... } }   */
const JUPITER_LITE_URL = `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`;

/* CoinGecko backup — different vendor, different infra, low cost.
 * Response shape: { "solana": { "usd": number } }   */
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

export interface SolPriceResult {
  priceUsd: number;
  /** Whether the value came from a live API or the in-memory fallback. */
  source: "jupiter" | "coingecko" | "cache_stale";
  /** Age of the value in milliseconds (0 for fresh live calls). */
  ageMs: number;
}

async function fromJupiterLite(): Promise<number> {
  const r = await fetch(JUPITER_LITE_URL);
  if (!r.ok) throw new Error(`jupiter_http_${r.status}`);
  const json = (await r.json()) as Record<
    string,
    { usdPrice?: number | string } | undefined
  >;
  const entry = json[SOL_MINT];
  const raw = entry?.usdPrice;
  if (raw == null) throw new Error("jupiter_no_sol_price");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error("jupiter_invalid_price");
  return n;
}

async function fromCoinGecko(): Promise<number> {
  const r = await fetch(COINGECKO_URL);
  if (!r.ok) throw new Error(`coingecko_http_${r.status}`);
  const json = (await r.json()) as { solana?: { usd?: number | string } };
  const raw = json.solana?.usd;
  if (raw == null) throw new Error("coingecko_no_sol_price");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error("coingecko_invalid_price");
  return n;
}

export async function fetchSolPriceUsd(): Promise<SolPriceResult> {
  const now = Date.now();

  // Fresh-cache hit
  if (_cache.latest && now - _cache.latest.fetchedAt < CACHE_TTL_MS) {
    return {
      priceUsd: _cache.latest.priceUsd,
      // Cached values report a generic "jupiter" tag; the caller doesn't
      // branch on this — it's purely diagnostic.
      source: "jupiter",
      ageMs: now - _cache.latest.fetchedAt,
    };
  }

  const errors: string[] = [];

  // 1) Jupiter Lite
  try {
    const priceUsd = await fromJupiterLite();
    _cache.latest = { priceUsd, fetchedAt: now };
    return { priceUsd, source: "jupiter", ageMs: 0 };
  } catch (err) {
    errors.push(`jupiter: ${(err as Error).message}`);
  }

  // 2) CoinGecko fallback
  try {
    const priceUsd = await fromCoinGecko();
    _cache.latest = { priceUsd, fetchedAt: now };
    console.info(
      `[solPrice] using-coingecko-fallback after jupiter failed (${errors[0]})`,
    );
    return { priceUsd, source: "coingecko", ageMs: 0 };
  } catch (err) {
    errors.push(`coingecko: ${(err as Error).message}`);
  }

  // 3) Stale-cache fallback
  if (
    _cache.latest &&
    now - _cache.latest.fetchedAt < STALE_FALLBACK_TTL_MS
  ) {
    console.warn(
      `[solPrice] both-providers-failed errors="${errors.join(" | ")}" ` +
        `using-stale ageMs=${now - _cache.latest.fetchedAt}`,
    );
    return {
      priceUsd: _cache.latest.priceUsd,
      source: "cache_stale",
      ageMs: now - _cache.latest.fetchedAt,
    };
  }

  // 4) No usable value — propagate so the caller can reject the user request.
  console.error(
    `[solPrice] price-feed-unavailable errors="${errors.join(" | ")}"`,
  );
  throw new Error(`sol_price_unavailable: ${errors.join(" | ")}`);
}
