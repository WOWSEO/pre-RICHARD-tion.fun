import type {
  CoinConfig,
  Snapshot,
  SourceName,
} from "../market/marketTypes";

/**
 * Abstraction the settlement engine uses to collect MC snapshots.
 * - MockProvider: fully programmable, used by tests + simulation
 * - DexScreener / GeckoTerminal: real `fetch` impls, ready to wire in
 * - Helius: supply truth + holder gating; not a primary MC source
 */
export interface MarketCapProvider {
  readonly name: SourceName;
  fetchSnapshot(coin: CoinConfig, now: Date): Promise<Snapshot>;
}
