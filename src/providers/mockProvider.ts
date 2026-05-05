import type {
  CoinConfig,
  Snapshot,
  SourceName,
} from "../market/marketTypes";
import type { MarketCapProvider } from "./providerTypes";

/**
 * Programmable mock provider. Tests/simulations script its behavior:
 *
 *   const mock = new MockProvider("dexscreener");
 *   mock.setMarketCap(60_000_000);
 *   mock.setMarketCapSequence([55e6, 56e6, 57e6]);
 *   mock.setMarketCapNoise(150_000);   // Gaussian-ish jitter (seeded PRNG)
 *   mock.setLiquidity(50_000);
 *   mock.setVolume24h(150_000);
 *   mock.setError("rate_limited");     // every fetch returns ok=false
 */
export class MockProvider implements MarketCapProvider {
  readonly name: SourceName;
  private mc: number | null = null;
  private mcSeq: number[] | null = null;
  private mcSeqIdx = 0;
  private noiseStd = 0;
  private price: number | null = null;
  private liquidity: number | null = 100_000;
  private volume24h: number | null = 200_000;
  private errorText: string | null = null;
  private rng: () => number;

  constructor(name: SourceName, opts: { seed?: number } = {}) {
    this.name = name;
    this.rng = mulberry32(opts.seed ?? 0xdead_beef);
  }

  setMarketCap(mc: number | null): this {
    this.mc = mc;
    this.mcSeq = null;
    return this;
  }
  setMarketCapSequence(seq: number[]): this {
    this.mcSeq = seq;
    this.mcSeqIdx = 0;
    return this;
  }
  setMarketCapNoise(stdDev: number): this {
    this.noiseStd = stdDev;
    return this;
  }
  setPrice(p: number | null): this {
    this.price = p;
    return this;
  }
  setLiquidity(l: number | null): this {
    this.liquidity = l;
    return this;
  }
  setVolume24h(v: number | null): this {
    this.volume24h = v;
    return this;
  }
  setError(msg: string | null): this {
    this.errorText = msg;
    return this;
  }

  async fetchSnapshot(_coin: CoinConfig, now: Date): Promise<Snapshot> {
    if (this.errorText) {
      return {
        source: this.name,
        fetchedAt: new Date(now.getTime()),
        marketCapUsd: null,
        priceUsd: null,
        liquidityUsd: this.liquidity,
        volume24hUsd: this.volume24h,
        ok: false,
        errorText: this.errorText,
        rawPayload: { mock: true, error: this.errorText },
      };
    }
    let mc: number | null = this.mc;
    if (this.mcSeq) {
      const v = this.mcSeq[this.mcSeqIdx % this.mcSeq.length];
      mc = v ?? null;
      this.mcSeqIdx++;
    }
    if (mc !== null && this.noiseStd > 0) {
      // crude central-limit-style normal: stack 4 uniforms
      const u = (this.rng() + this.rng() + this.rng() + this.rng() - 2) * 1.225;
      mc = mc + u * this.noiseStd;
    }
    return {
      source: this.name,
      fetchedAt: new Date(now.getTime()),
      marketCapUsd: mc,
      priceUsd: this.price,
      liquidityUsd: this.liquidity,
      volume24hUsd: this.volume24h,
      ok: mc !== null,
      errorText: null,
      rawPayload: { mock: true, mc },
    };
  }
}

/** Tiny seedable PRNG so test runs are deterministic. */
function mulberry32(a: number): () => number {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
