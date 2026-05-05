import type {
  CoinConfig,
  Snapshot,
  SourceName,
} from "../market/marketTypes";
import type { MarketCapProvider } from "./providerTypes";

/**
 * Real GeckoTerminal provider — wired but unused by default in the brain POC.
 *
 * Endpoint: GET https://api.geckoterminal.com/api/v2/networks/solana/tokens/{mint}
 *   - Free, no auth, 30 req/min.
 *   - For multi-coin: switch to `/tokens/multi/{mint1,mint2,...}` (up to 30/call).
 *   - `attributes.market_cap_usd` is often null for launchpad memes;
 *     use `attributes.fdv_usd` as the canonical MC field.
 */
export class GeckoTerminalProvider implements MarketCapProvider {
  readonly name: SourceName = "geckoterminal";
  private baseUrl: string;

  constructor(opts: { baseUrl?: string } = {}) {
    this.baseUrl = opts.baseUrl ?? "https://api.geckoterminal.com";
  }

  async fetchSnapshot(coin: CoinConfig, now: Date): Promise<Snapshot> {
    const url = `${this.baseUrl}/api/v2/networks/solana/tokens/${coin.mintAddress}`;
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json;version=20230302" },
      });
      if (!res.ok) {
        return errSnap(this.name, now, `HTTP ${res.status}`, { url, status: res.status });
      }
      const body = (await res.json()) as GtTokenResponse;
      const attrs = body.data?.attributes;
      if (!attrs) return errSnap(this.name, now, "no_data", body);
      const fdv = attrs.fdv_usd != null ? Number(attrs.fdv_usd) : null;
      const mcGc =
        attrs.market_cap_usd != null ? Number(attrs.market_cap_usd) : null;
      const price = attrs.price_usd != null ? Number(attrs.price_usd) : null;
      const mc = fdv ?? mcGc;
      const liq =
        attrs.total_reserve_in_usd != null
          ? Number(attrs.total_reserve_in_usd)
          : null;
      const vol24 =
        attrs.volume_usd?.h24 != null ? Number(attrs.volume_usd.h24) : null;
      return {
        source: this.name,
        fetchedAt: now,
        marketCapUsd: mc,
        priceUsd: price,
        liquidityUsd: liq,
        volume24hUsd: vol24,
        ok: mc != null,
        errorText: mc == null ? "missing_mc" : null,
        rawPayload: body,
      };
    } catch (err) {
      return errSnap(this.name, now, (err as Error).message, { url, error: String(err) });
    }
  }
}

interface GtTokenResponse {
  data?: {
    attributes?: {
      fdv_usd?: string | number | null;
      market_cap_usd?: string | number | null;
      price_usd?: string | number | null;
      total_reserve_in_usd?: string | number | null;
      volume_usd?: { h24?: string | number | null };
    };
  };
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
