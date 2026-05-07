import type { CoinConfig, Snapshot, SourceName } from "../../src/market/marketTypes";
import type { MarketCapProvider } from "../../src/providers/providerTypes";
import { db, type OracleSnapshotRow } from "../db/supabase";

/**
 * Wraps a brain MarketCapProvider with a cache fallback so settlement-time
 * polling can survive provider outages.
 *
 * Why this exists:
 *   The brain's `collectSnapshotsSynthetic` polls each provider at multiple
 *   synthetic timestamps inside the close window — typically 4 timestamps ×
 *   2 providers = 8 live API hits per settlement.  When DexScreener or
 *   GeckoTerminal rate-limit (429), the brain gets `ok=false` snapshots,
 *   fails the resolver's `minSnapshotsPerSource` check, and voids the
 *   market with `insufficient_snapshots`.  In production this cascades:
 *   stuck market → void → user refunds → no settlement_mc to display.
 *
 *   The tick endpoint's pre-fetch already populates `oracle_snapshots` with
 *   the most-recent live MC reading.  This wrapper exposes that cache to
 *   the brain: when the inner provider fails, we read the cache for the
 *   wrapper's source name and synthesize a Snapshot at the requested
 *   timestamp.  Settlement keeps working as long as the cache is fresh.
 *
 * Failure mode:
 *   When BOTH live and cache fail, the live failure is returned verbatim
 *   (errorText preserved).  The brain then voids the market with a clear
 *   reason path — same behavior as before this wrapper existed, just
 *   reached only when the cache also has no fresh row.
 */
export class CachedBrainProvider implements MarketCapProvider {
  readonly name: SourceName;

  constructor(
    private readonly inner: MarketCapProvider,
    /** Max age for a cache hit to count as fresh.  Default 30 min — bumped
     *  from 5 in v27 to absorb DexScreener's 429 rate-limit storms during
     *  settle.  A 25-min-old MC reading is still accurate enough for
     *  "did MC cross target at close" given typical TROLL volatility
     *  vs target offsets. */
    private readonly maxCacheAgeMs: number = 30 * 60 * 1000,
    /** Cache row symbol.  Default "TROLL" — matches what marketSnapshot.ts
     *  writes. */
    private readonly symbol: string = "TROLL",
  ) {
    this.name = inner.name;
  }

  async fetchSnapshot(coin: CoinConfig, now: Date): Promise<Snapshot> {
    const liveSnap = await this.inner.fetchSnapshot(coin, now);
    if (liveSnap.ok) {
      return liveSnap;
    }

    // Live failed — try cache.  Match cache rows by `source` so a
    // GeckoTerminal-wrapped instance only reads gecko-sourced cache rows
    // (preserves the brain's source-disagreement check semantically: two
    // wrapped providers on different cache sources will still detect when
    // the two sources actually disagreed at last-known time).
    const cached = await readCachedRowForSource(this.name, this.maxCacheAgeMs, this.symbol);
    if (cached) {
      console.info(
        `[settle/cache] hit source=${this.name} ageMs=${cached.ageMs} ` +
          `mc=$${(cached.marketCapUsd / 1e6).toFixed(2)}M ` +
          `(live failed: ${liveSnap.errorText ?? "no error text"})`,
      );
      return {
        source: this.name,
        fetchedAt: now, // synthesise the brain's requested timestamp
        marketCapUsd: cached.marketCapUsd,
        priceUsd: cached.priceUsd,
        liquidityUsd: null,
        volume24hUsd: null,
        ok: true,
        errorText: null,
        rawPayload: { fromCache: true, ageMs: cached.ageMs, originalLiveError: liveSnap.errorText },
      };
    }

    // Neither live nor cache.  Return the original live failure verbatim
    // so the brain's resolver fails with the actual provider error string.
    console.warn(
      `[settle/cache] miss source=${this.name} liveErr=${liveSnap.errorText ?? "(no text)"} ` +
        `→ voiding with live error`,
    );
    return liveSnap;
  }
}

interface CachedRow {
  marketCapUsd: number;
  priceUsd: number;
  ageMs: number;
}

async function readCachedRowForSource(
  source: SourceName,
  maxAgeMs: number,
  symbol: string,
): Promise<CachedRow | null> {
  try {
    const sb = db();
    const { data, error } = await sb
      .from("oracle_snapshots")
      .select("*")
      .eq("symbol", symbol)
      .eq("source", source)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<OracleSnapshotRow>();
    if (error) {
      console.warn(`[settle/cache] read-error source=${source} ${error.message}`);
      return null;
    }
    if (!data) return null;
    const ageMs = Date.now() - new Date(data.created_at).getTime();
    if (ageMs > maxAgeMs) return null;
    const mc = Number(data.market_cap);
    const price = Number(data.price_usd);
    if (!Number.isFinite(mc) || mc <= 0) return null;
    return {
      marketCapUsd: mc,
      priceUsd: Number.isFinite(price) && price > 0 ? price : 0,
      ageMs,
    };
  } catch (err) {
    console.warn(`[settle/cache] read-threw source=${source} ${(err as Error).message}`);
    return null;
  }
}
