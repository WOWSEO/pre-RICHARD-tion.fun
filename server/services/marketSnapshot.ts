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
 * Resolution chain (in order):
 *   1. DexScreener pair API (primary — same source the frontend MC card uses)
 *   2. GeckoTerminal token API (fallback)
 *   3. oracle_snapshots cache table — most-recent row for this symbol, IF
 *      newer than `cacheMaxAgeMs` (default 5 min).  Used when steps 1 and 2
 *      both fail (typically with 429).
 *   4. Throw a specific, structured error string that callers surface
 *      verbatim — e.g. "snapshot_unavailable_no_fresh_cache: dexscreener:
 *      dexscreener_429 | geckoterminal: geckoterminal_429 | cache: 7m23s old".
 *
 * Every successful live fetch is written to oracle_snapshots so future
 * tick invocations have a fallback when both providers rate-limit.
 */

import { TROLL } from "../../src/config/troll";
import { db, type OracleSnapshotRow } from "../db/supabase";
import type { CoinConfig } from "../../src/market/marketTypes";

export interface LiveSnapshot {
  /** UI USD price per token, e.g. 0.000043 */
  priceUsd: number;
  /** USD market cap (FDV is treated as MC for this token) */
  marketCapUsd: number;
  /** When the snapshot was actually fetched (or, if cached, when the cached
   *  row was originally fetched). */
  fetchedAt: Date;
  /** Origin: which provider produced the value, or "manual" for operator-
   *  supplied snapshots via /api/admin/seed-markets-from-manual-snapshot. */
  source: "dexscreener" | "geckoterminal" | "manual";
  /** True if this snapshot was read from the oracle_snapshots cache.
   *  False for live fetches and manual snapshots. */
  fromCache: boolean;
  /** Milliseconds since the original fetch.  0 for live; n>0 for cache;
   *  0 for manual (just-now). */
  ageMs: number;
}

const DEFAULT_CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes per spec
const TROLL_SYMBOL = "TROLL";

/**
 * v53 — extract the pair address from a coin's dexscreener_embed_url.
 *
 * The "pair" is the LP pair address (the slug at the end of the dexscreener
 * embed URL).  We need it for the live-data API endpoint, which uses pair
 * addresses, not token mints.  Pair pages look like:
 *   https://dexscreener.com/solana/<pairAddress>
 *
 * For TROLL the env var DEXSCREENER_PAIR_URL is the legacy override; if set,
 * it wins.  For other coins we extract from the coin's embed URL.
 */
function pairAddressFromEmbedUrl(embedUrl: string): string {
  const tail = embedUrl.split("/").filter(Boolean).pop();
  return tail || "";
}

function getPairAddressForCoin(coin: CoinConfig): string {
  // Legacy: TROLL respects the env override for backwards compat with
  // pre-v53 deployments that hardcoded the env var.
  if (coin.symbol === "TROLL") {
    const url =
      process.env.DEXSCREENER_PAIR_URL ??
      process.env.VITE_DEXSCREENER_PAIR_URL;
    if (url) {
      const tail = url.split("/").filter(Boolean).pop();
      if (tail) return tail;
    }
  }
  // Default: extract from the coin's dexscreener_embed_url (or
  // dexscreenerSource, which is the API URL — fall through both).
  const fromSource = pairAddressFromEmbedUrl(coin.dexscreenerSource);
  if (fromSource) return fromSource;
  // Last resort fallback for pre-existing TROLL deployments
  return "4w2cysotx6czaugmmwg13hdpy4qemg2czekyeqyk9ama";
}

/* ------------------------------------------------------------------------- */
/* Live providers                                                            */
/* ------------------------------------------------------------------------- */

interface ProviderResult {
  snap: LiveSnapshot;
  rawPayload: unknown;
}

async function fromDexScreener(coin: CoinConfig): Promise<ProviderResult> {
  const pair = getPairAddressForCoin(coin);
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
    snap: {
      priceUsd,
      marketCapUsd: mc,
      fetchedAt: new Date(),
      source: "dexscreener",
      fromCache: false,
      ageMs: 0,
    },
    rawPayload: data,
  };
}

async function fromGeckoTerminal(coin: CoinConfig): Promise<ProviderResult> {
  // For TROLL, env override wins (pre-v53 backwards compat).
  // For other coins, always use the coin's mint.
  const mint =
    coin.symbol === "TROLL"
      ? process.env.TROLL_MINT ?? coin.mintAddress
      : coin.mintAddress;
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
    snap: {
      priceUsd,
      marketCapUsd: mc,
      fetchedAt: new Date(),
      source: "geckoterminal",
      fromCache: false,
      ageMs: 0,
    },
    rawPayload: data,
  };
}

/* ------------------------------------------------------------------------- */
/* Cache                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Persist a snapshot to oracle_snapshots.  Called after every successful live
 * fetch AND after the manual-snapshot admin endpoint runs.  Failures here are
 * logged but NEVER thrown — caching is best-effort, and if Supabase is
 * unhappy we'd rather still serve the live value to the seeder.
 */
export async function saveSnapshotToCache(
  snap: LiveSnapshot,
  rawPayload: unknown,
  symbol: string = TROLL_SYMBOL,
): Promise<void> {
  try {
    const sb = db();
    const { error } = await sb.from("oracle_snapshots").insert({
      symbol,
      price_usd: snap.priceUsd.toString(),
      market_cap: snap.marketCapUsd.toString(),
      fdv: snap.marketCapUsd.toString(), // for $TROLL, FDV == MC
      source: snap.source,
      raw_payload: rawPayload ?? null,
      created_at: snap.fetchedAt.toISOString(),
    });
    if (error) {
      console.warn(`[snapshot/cache] save-failed reason=${error.message}`);
      return;
    }
    console.info(
      `[snapshot/cache] saved source=${snap.source} mc=$${(snap.marketCapUsd / 1e6).toFixed(2)}M`,
    );
  } catch (err) {
    console.warn(`[snapshot/cache] save-threw reason=${(err as Error).message}`);
  }
}

/**
 * Read the most-recent oracle_snapshots row for `symbol`.  Returns null if no
 * row exists or the row is older than `maxAgeMs` (default 5 min).
 *
 * Stale-cache rejection happens here, not at insert time, so freshness window
 * tuning doesn't require a DB migration.
 */
export async function readFreshCachedSnapshot(
  symbol: string = TROLL_SYMBOL,
  maxAgeMs: number = DEFAULT_CACHE_MAX_AGE_MS,
): Promise<LiveSnapshot | null> {
  try {
    const sb = db();
    const { data, error } = await sb
      .from("oracle_snapshots")
      .select("*")
      .eq("symbol", symbol)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<OracleSnapshotRow>();
    if (error) {
      console.warn(`[snapshot/cache] read-failed reason=${error.message}`);
      return null;
    }
    if (!data) {
      console.info("[snapshot/cache] miss reason=no_rows");
      return null;
    }
    const fetchedAt = new Date(data.created_at);
    const ageMs = Date.now() - fetchedAt.getTime();
    if (ageMs > maxAgeMs) {
      console.info(
        `[snapshot/cache] stale ageMs=${ageMs} maxAgeMs=${maxAgeMs} ` +
          `cachedAt=${data.created_at}`,
      );
      return null;
    }
    const sourceStr = data.source as LiveSnapshot["source"];
    const validSource: LiveSnapshot["source"] =
      sourceStr === "dexscreener" || sourceStr === "geckoterminal" || sourceStr === "manual"
        ? sourceStr
        : "dexscreener"; // belt-and-braces — should never happen
    return {
      priceUsd: Number(data.price_usd),
      marketCapUsd: Number(data.market_cap),
      fetchedAt,
      source: validSource,
      fromCache: true,
      ageMs,
    };
  } catch (err) {
    console.warn(`[snapshot/cache] read-threw reason=${(err as Error).message}`);
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

export interface FetchOptions {
  /** Max age (ms) for a cache hit to count as fresh.  Default 5 min. */
  cacheMaxAgeMs?: number;
  /** Symbol used for cache key.  Default "TROLL". */
  symbol?: string;
}

/**
 * v53 — Take a fresh snapshot for an arbitrary coin.  Tries DexScreener
 * first, falls back to GeckoTerminal, then the cache (keyed by symbol so
 * each coin has its own cache lane).  Throws a structured error string if
 * all three paths fail.
 *
 * Error shapes (callers surface these verbatim — they're public API):
 *   - "live_snapshot_failed: dexscreener: <reason> | geckoterminal: <reason>"
 *     (no fresh cache existed or cache read errored)
 *   - "snapshot_unavailable_no_fresh_cache: dexscreener: <reason> |
 *      geckoterminal: <reason> | cache: <ageMs>ms old"
 *     (cache exists but is stale)
 *
 * The two error shapes are distinguished so the operator can tell whether
 * the system has *ever* seen a snapshot or just hasn't seen one in 5 min.
 */
export async function fetchCoinSnapshot(
  coin: CoinConfig,
  opts: FetchOptions = {},
): Promise<LiveSnapshot> {
  const cacheMaxAgeMs = opts.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS;
  const symbol = opts.symbol ?? coin.symbol;
  const errors: string[] = [];

  // 1) DexScreener
  try {
    const r = await fromDexScreener(coin);
    await saveSnapshotToCache(r.snap, r.rawPayload, symbol);
    return r.snap;
  } catch (err) {
    errors.push(`dexscreener: ${(err as Error).message}`);
  }

  // 2) GeckoTerminal
  try {
    const r = await fromGeckoTerminal(coin);
    await saveSnapshotToCache(r.snap, r.rawPayload, symbol);
    return r.snap;
  } catch (err) {
    errors.push(`geckoterminal: ${(err as Error).message}`);
  }

  // 3) Cache fallback
  console.warn(
    `[snapshot] both-providers-failed coin=${coin.symbol} errors="${errors.join(" | ")}"`,
  );
  const cached = await readFreshCachedSnapshot(symbol, cacheMaxAgeMs);
  if (cached) {
    console.info(
      `[snapshot] cache-hit coin=${coin.symbol} source=${cached.source} ageMs=${cached.ageMs} ` +
        `mc=$${(cached.marketCapUsd / 1e6).toFixed(2)}M`,
    );
    return cached;
  }

  // 4) No fresh cache — distinguish "never had one" vs "had one but stale"
  let cacheDescriptor = "cache: missing";
  try {
    const sb = db();
    const { data } = await sb
      .from("oracle_snapshots")
      .select("created_at")
      .eq("symbol", symbol)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ created_at: string }>();
    if (data) {
      const ageMs = Date.now() - new Date(data.created_at).getTime();
      cacheDescriptor = `cache: ${Math.round(ageMs / 1000)}s old (max ${Math.round(cacheMaxAgeMs / 1000)}s)`;
    }
  } catch {
    // best-effort
  }

  throw new Error(
    `snapshot_unavailable_no_fresh_cache: ${errors.join(" | ")} | ${cacheDescriptor}`,
  );
}

/**
 * Backwards-compatible TROLL-only wrapper.  Pre-v53 callers continue to work.
 * New code should call fetchCoinSnapshot(coin) directly.
 */
export async function fetchTrollSnapshot(opts: FetchOptions = {}): Promise<LiveSnapshot> {
  return fetchCoinSnapshot(TROLL, opts);
}

/**
 * Build a manual snapshot from operator-supplied numbers (admin endpoint).
 * Persists it to the cache so subsequent automatic ticks have something to
 * fall back to even if both providers stay rate-limited.
 */
export async function buildManualSnapshot(input: {
  marketCapUsd: number;
  priceUsd?: number;
  source?: string;
  symbol?: string;
}): Promise<LiveSnapshot> {
  const symbol = input.symbol ?? TROLL_SYMBOL;
  if (!Number.isFinite(input.marketCapUsd) || input.marketCapUsd <= 0) {
    throw new Error("manual_snapshot_invalid_market_cap");
  }
  // For a market-cap-only entry, we don't strictly need price for the
  // higher/lower lifecycle (target_mc = open_mc).  Default to a placeholder
  // proportional to MC so downstream display code has a non-zero number.
  // This is non-canonical and will be overwritten by the next live fetch.
  const priceUsd =
    input.priceUsd != null && Number.isFinite(input.priceUsd) && input.priceUsd > 0
      ? input.priceUsd
      : input.marketCapUsd / 1_000_000_000;
  const snap: LiveSnapshot = {
    priceUsd,
    marketCapUsd: input.marketCapUsd,
    fetchedAt: new Date(),
    source: "manual",
    fromCache: false,
    ageMs: 0,
  };
  await saveSnapshotToCache(
    snap,
    {
      provided: { marketCap: input.marketCapUsd, priceUsd: input.priceUsd ?? null },
      source_label: input.source ?? "manual",
    },
    symbol,
  );
  return snap;
}

/**
 * v27 — opportunistic cache warmer.  Called once per tick.
 *
 * If the latest cache row is older than `maxAgeMs`, fires ONE live snapshot
 * fetch (which writes the cache as a side effect).  Otherwise returns
 * immediately without hitting providers.
 *
 * This dramatically reduces 429 risk during settle: by warming the cache
 * once per tick during open windows, settlement finds a fresh cache row
 * and never has to hit providers itself.
 *
 * Failures are non-fatal and silent — caller should log if needed but
 * not error out (a single failed warm doesn't break anything; the next
 * tick retries).  Returns whether a refresh was actually performed.
 */
export async function warmSnapshotIfStale(
  maxAgeMs: number = 60_000, // default: refresh if cache > 60s old
  symbol: string = TROLL_SYMBOL,
  coin: CoinConfig = TROLL,
): Promise<{ refreshed: boolean; reason: string }> {
  // v46 — fetchTrollSnapshot returns on first success (dex usually), so the
  // geckoterminal cache row never gets refreshed and the settle engine voids
  // markets on insufficient_snapshots_geckoterminal.  We now warm BOTH
  // providers' cache entries explicitly, keyed by `source`, so settle finds
  // fresh rows for both providers.
  // v53 — providers now take a CoinConfig.  Default coin = TROLL preserves
  // pre-v53 single-coin behaviour for callers that don't pass a coin.
  const sources: Array<{
    name: "dexscreener" | "geckoterminal";
    fn: (c: CoinConfig) => Promise<ProviderResult>;
  }> = [
    { name: "dexscreener", fn: fromDexScreener },
    { name: "geckoterminal", fn: fromGeckoTerminal },
  ];

  const results: string[] = [];
  let anyRefreshed = false;

  for (const { name, fn } of sources) {
    try {
      const sb = db();
      const { data } = await sb
        .from("oracle_snapshots")
        .select("created_at")
        .eq("symbol", symbol)
        .eq("source", name)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ created_at: string }>();
      if (data) {
        const ageMs = Date.now() - new Date(data.created_at).getTime();
        if (ageMs < maxAgeMs) {
          results.push(`${name}=fresh(${ageMs}ms)`);
          continue;
        }
      }
    } catch {
      // fall through and refresh
    }

    // Cache is stale or missing for this source — try ONE live fetch.
    // Best-effort: a 429 here is fine, it just means we'll retry next tick.
    try {
      const r = await fn(coin);
      await saveSnapshotToCache(r.snap, r.rawPayload, symbol);
      results.push(`${name}=refreshed`);
      anyRefreshed = true;
    } catch (err) {
      results.push(`${name}=fail(${(err as Error).message})`);
    }
  }

  return { refreshed: anyRefreshed, reason: results.join(",") };
}
