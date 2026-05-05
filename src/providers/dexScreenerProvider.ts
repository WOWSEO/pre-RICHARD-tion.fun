import type {
  CoinConfig,
  Snapshot,
  SourceName,
} from "../market/marketTypes";
import type { MarketCapProvider } from "./providerTypes";

/**
 * Real DexScreener provider — wired but unused by default in the brain POC.
 *
 * Endpoint: GET https://api.dexscreener.com/token-pairs/v1/solana/{mint}
 *   - Free, no auth, 300 req/min on this endpoint family.
 *   - Returns an array of pairs across DEXes; pick the highest-liquidity pair.
 *   - Use `fdv` as the canonical MC field — for Pump.fun-origin memes,
 *     supply is fixed and unlocked so FDV ≈ market cap, and `marketCap` is
 *     often null/stale.
 */
export class DexScreenerProvider implements MarketCapProvider {
  readonly name: SourceName = "dexscreener";
  private baseUrl: string;

  constructor(opts: { baseUrl?: string } = {}) {
    this.baseUrl = opts.baseUrl ?? "https://api.dexscreener.com";
  }

  async fetchSnapshot(coin: CoinConfig, now: Date): Promise<Snapshot> {
    const url = `${this.baseUrl}/token-pairs/v1/solana/${coin.mintAddress}`;
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        return errSnap(this.name, now, `HTTP ${res.status}`, { url, status: res.status });
      }
      const body = (await res.json()) as
        | DexScreenerPair[]
        | { pairs?: DexScreenerPair[] };
      const pairs = Array.isArray(body) ? body : body.pairs ?? [];
      if (pairs.length === 0) return errSnap(this.name, now, "no_pairs", body);
      const canonical = [...pairs].sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
      )[0]!;
      const mc = canonical.fdv ?? canonical.marketCap ?? null;
      const price = canonical.priceUsd != null ? Number(canonical.priceUsd) : null;
      return {
        source: this.name,
        fetchedAt: now,
        marketCapUsd: mc,
        priceUsd: price,
        liquidityUsd: canonical.liquidity?.usd ?? null,
        volume24hUsd: canonical.volume?.h24 ?? null,
        ok: mc != null,
        errorText: mc == null ? "missing_mc" : null,
        rawPayload: canonical,
      };
    } catch (err) {
      return errSnap(this.name, now, (err as Error).message, { url, error: String(err) });
    }
  }
}

interface DexScreenerPair {
  fdv?: number;
  marketCap?: number;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairAddress?: string;
  dexId?: string;
  url?: string;
}

function errSnap(source: SourceName, now: Date, msg: string, raw: unknown): Snapshot {
  return {
    source,
    fetchedAt: now,
    marketCapUsd: null,
    priceUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    ok: false,
    errorText: msg,
    rawPayload: raw,
  };
}
