import type {
  CoinConfig,
  Snapshot,
  SourceName,
} from "../market/marketTypes";
import type { MarketCapProvider } from "./providerTypes";

/**
 * Helius provider — wired but unused by default in the brain POC.
 *
 * Helius is NOT a primary MC source in our stack; its job is:
 *   1. `getTokenSupply(mint)` — canonical on-chain total supply, sanity-check
 *      against FDV from DexScreener / GeckoTerminal.
 *   2. `getTokenAccountsByOwner(wallet, { mint })` — holder gate at room entry
 *      (not exercised by this POC; lives at the API layer in a future phase).
 *   3. Bonding-curve fallback for pre-graduation Pump.fun tokens — out of scope
 *      because the admin universe must contain post-graduation tokens only.
 *
 * This stub implements (1) only and exposes it as a Snapshot with marketCapUsd
 * left null — the resolver ignores Helius for MC consensus.
 */
export class HeliusProvider implements MarketCapProvider {
  readonly name: SourceName = "helius_curve";
  private rpcUrl: string;

  constructor(opts: { rpcUrl?: string; apiKey?: string } = {}) {
    const key = opts.apiKey ?? process.env.HELIUS_API_KEY ?? "";
    this.rpcUrl = opts.rpcUrl ?? `https://mainnet.helius-rpc.com/?api-key=${key}`;
  }

  async fetchSnapshot(coin: CoinConfig, now: Date): Promise<Snapshot> {
    try {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenSupply",
          params: [coin.mintAddress],
        }),
      });
      if (!res.ok) return errSnap(this.name, now, `HTTP ${res.status}`);
      const body = (await res.json()) as {
        result?: { value?: { amount?: string; decimals?: number; uiAmount?: number } };
        error?: { message?: string };
      };
      if (body.error) return errSnap(this.name, now, body.error.message ?? "rpc_error");
      return {
        source: this.name,
        fetchedAt: now,
        marketCapUsd: null,
        priceUsd: null,
        liquidityUsd: null,
        volume24hUsd: null,
        ok: true,
        errorText: null,
        rawPayload: body.result,
      };
    } catch (err) {
      return errSnap(this.name, now, (err as Error).message);
    }
  }
}

function errSnap(source: SourceName, now: Date, msg: string): Snapshot {
  return {
    source,
    fetchedAt: now,
    marketCapUsd: null,
    priceUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    ok: false,
    errorText: msg,
    rawPayload: { error: msg },
  };
}
