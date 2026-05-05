import { describe, it, expect } from "vitest";
import { TROLL } from "../config/troll";
import { createMarket } from "../market/scheduler";
import { buyYes, buyNo } from "../market/tradeEngine";
import { settleMarket, resolve } from "../market/settlementEngine";
import { MockProvider } from "../providers/mockProvider";
import { MemoryStore } from "../store/memoryStore";
import type { Snapshot, Market, ResolverInput } from "../market/marketTypes";

function setupMarket(targetMc = 60_000_000) {
  const store = new MemoryStore();
  const market = store.addMarket(
    createMarket({
      symbol: "TROLL",
      scheduleType: "15m",
      // closeAt in the past so settleMarket can collect retro snapshots without sleeping.
      closeAt: new Date(Date.now() - 60_000),
      targetMc,
    }),
  );
  return { store, market };
}

describe("payout direction", () => {
  it("YES settlement pays YES shares at 100¢, losing NO shares at 0¢", async () => {
    const { store, market } = setupMarket(60_000_000);
    const alice = store.upsertUser("alice", 1000);
    const bob = store.upsertUser("bob", 1000);

    const aliceBuy = buyYes(alice, market, 200);
    const bobBuy = buyNo(bob, market, 200);

    const aliceBalanceBeforeSettle = alice.trollBalance;
    const bobBalanceBeforeSettle = bob.trollBalance;

    const dex = new MockProvider("dexscreener", { seed: 1 })
      .setMarketCap(72_000_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);
    const gecko = new MockProvider("geckoterminal", { seed: 2 })
      .setMarketCap(72_300_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);

    const receipt = await settleMarket({
      market,
      coin: TROLL,
      providers: [dex, gecko],
      users: store.users,
    });

    expect(receipt.outcome).toBe("YES");

    // Alice: YES winner. Payout = shares × 1.0 TROLL.
    const aliceExpectedPayout = aliceBuy.quote.shares * 1.0;
    expect(alice.trollBalance).toBeCloseTo(
      aliceBalanceBeforeSettle + aliceExpectedPayout,
      6,
    );

    // Bob: NO loser. Payout = 0.
    expect(bob.trollBalance).toBeCloseTo(bobBalanceBeforeSettle, 12);
    expect(bobBuy.quote.shares).toBeGreaterThan(0); // sanity
  });

  it("NO settlement pays NO shares at 100¢, losing YES shares at 0¢", async () => {
    const { store, market } = setupMarket(60_000_000);
    const alice = store.upsertUser("alice", 1000);
    const bob = store.upsertUser("bob", 1000);

    buyYes(alice, market, 200);
    const bobBuy = buyNo(bob, market, 200);

    const aliceBalanceBeforeSettle = alice.trollBalance;
    const bobBalanceBeforeSettle = bob.trollBalance;

    const dex = new MockProvider("dexscreener", { seed: 11 })
      .setMarketCap(48_000_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);
    const gecko = new MockProvider("geckoterminal", { seed: 22 })
      .setMarketCap(48_300_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);

    const receipt = await settleMarket({
      market,
      coin: TROLL,
      providers: [dex, gecko],
      users: store.users,
    });

    expect(receipt.outcome).toBe("NO");
    expect(alice.trollBalance).toBeCloseTo(aliceBalanceBeforeSettle, 12);
    const bobExpectedPayout = bobBuy.quote.shares * 1.0;
    expect(bob.trollBalance).toBeCloseTo(
      bobBalanceBeforeSettle + bobExpectedPayout,
      6,
    );
  });
});

describe("user entry price affects payout", () => {
  it("two YES holders at different entry prices realize different per-share PnL", async () => {
    const { store, market } = setupMarket(60_000_000);
    const alice = store.upsertUser("alice", 1000);
    const bob = store.upsertUser("bob", 1000);
    const carol = store.upsertUser("carol", 1000);

    // Alice enters YES first at ~50¢.
    const aliceBuy = buyYes(alice, market, 100);
    // Bob crashes the YES price by buying a lot of NO.
    buyNo(bob, market, 800);
    // Carol enters YES at the new (much lower) price.
    const carolBuy = buyYes(carol, market, 100);

    // Sanity: Carol's avg entry should be much lower than Alice's avg entry.
    const alicePos = market.positions.find(
      (p) => p.wallet === "alice" && p.side === "YES",
    )!;
    const carolPos = market.positions.find(
      (p) => p.wallet === "carol" && p.side === "YES",
    )!;
    expect(carolPos.averageEntryPriceCents).toBeLessThan(
      alicePos.averageEntryPriceCents,
    );

    // Settle YES wins.
    const dex = new MockProvider("dexscreener", { seed: 31 })
      .setMarketCap(72_000_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);
    const gecko = new MockProvider("geckoterminal", { seed: 32 })
      .setMarketCap(72_300_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);

    const receipt = await settleMarket({
      market,
      coin: TROLL,
      providers: [dex, gecko],
      users: store.users,
    });

    expect(receipt.outcome).toBe("YES");

    // Both win; payout = shares. PnL = shares × (1 − avgEntry/100).
    // Per-share PnL = 1 − avgEntry. Carol's entry is lower ⇒ Carol's per-share PnL is higher.
    const aliceSettlement = receipt.userSettlements.find(
      (s) => s.wallet === "alice",
    )!;
    const carolSettlement = receipt.userSettlements.find(
      (s) => s.wallet === "carol",
    )!;
    const alicePerShare =
      aliceSettlement.realizedPnlOnSettlement / aliceBuy.quote.shares;
    const carolPerShare =
      carolSettlement.realizedPnlOnSettlement / carolBuy.quote.shares;
    expect(carolPerShare).toBeGreaterThan(alicePerShare);

    // And Carol bought MORE shares for the same TROLL because the price was lower.
    expect(carolBuy.quote.shares).toBeGreaterThan(aliceBuy.quote.shares);
  });
});

describe("void rules", () => {
  it("voids on source disagreement > 2.5%", async () => {
    const { store, market } = setupMarket(60_000_000);
    const alice = store.upsertUser("alice", 1000);
    buyYes(alice, market, 100);
    const balanceAfterBuy = alice.trollBalance;

    // 5% disagreement between sources → void.
    const dex = new MockProvider("dexscreener", { seed: 41 })
      .setMarketCap(70_000_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);
    const gecko = new MockProvider("geckoterminal", { seed: 42 })
      .setMarketCap(74_000_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);

    const receipt = await settleMarket({
      market,
      coin: TROLL,
      providers: [dex, gecko],
      users: store.users,
    });

    expect(receipt.outcome).toBe("VOID");
    expect(receipt.voidReason).toBe("source_disagreement");
    // Alice gets her cost basis (100 TROLL) back. balance = balanceAfterBuy + 100.
    expect(alice.trollBalance).toBeCloseTo(balanceAfterBuy + 100, 6);
  });

  it("voids on dead-zone (canonical MC within 0.1% of target)", async () => {
    const { store, market } = setupMarket(60_000_000);
    const alice = store.upsertUser("alice", 1000);
    const aliceBuy = buyYes(alice, market, 100);
    const aliceBasisBeforeSettle = aliceBuy.quote.trollAmount; // 100 TROLL
    const balanceBeforeSettle = alice.trollBalance;

    // canonical MC = $60.01M; target = $60M; deviation ≈ 0.017% < 0.1% → void.
    const dex = new MockProvider("dexscreener", { seed: 51 })
      .setMarketCap(60_010_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);
    const gecko = new MockProvider("geckoterminal", { seed: 52 })
      .setMarketCap(60_010_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);

    const receipt = await settleMarket({
      market,
      coin: TROLL,
      providers: [dex, gecko],
      users: store.users,
    });
    expect(receipt.outcome).toBe("VOID");
    expect(receipt.voidReason).toBe("dead_zone");
    expect(alice.trollBalance).toBeCloseTo(
      balanceBeforeSettle + aliceBasisBeforeSettle,
      6,
    );
  });

  it("voids on insufficient snapshots from a source", async () => {
    const { store, market } = setupMarket(60_000_000);
    const alice = store.upsertUser("alice", 1000);
    buyYes(alice, market, 100);
    const balanceAfterBuy = alice.trollBalance;

    // DexScreener errors out on every fetch → 0 valid snapshots.
    const dex = new MockProvider("dexscreener", { seed: 61 }).setError(
      "rate_limited",
    );
    const gecko = new MockProvider("geckoterminal", { seed: 62 })
      .setMarketCap(72_000_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);

    const receipt = await settleMarket({
      market,
      coin: TROLL,
      providers: [dex, gecko],
      users: store.users,
    });
    expect(receipt.outcome).toBe("VOID");
    expect(receipt.voidReason).toBe("insufficient_snapshots_dexscreener");
    expect(alice.trollBalance).toBeCloseTo(balanceAfterBuy + 100, 6);
  });

  it("voids when liquidity falls below floor", async () => {
    const { store, market } = setupMarket(60_000_000);
    const alice = store.upsertUser("alice", 1000);
    buyYes(alice, market, 100);

    const dex = new MockProvider("dexscreener", { seed: 71 })
      .setMarketCap(72_000_000)
      .setLiquidity(5_000) // below $25k floor
      .setVolume24h(150_000);
    const gecko = new MockProvider("geckoterminal", { seed: 72 })
      .setMarketCap(72_000_000)
      .setLiquidity(5_000)
      .setVolume24h(150_000);

    const receipt = await settleMarket({
      market,
      coin: TROLL,
      providers: [dex, gecko],
      users: store.users,
    });
    expect(receipt.outcome).toBe("VOID");
    expect(receipt.voidReason).toBe("liquidity_below_floor");
  });

  it("voids when 24h volume falls below floor", async () => {
    const { store, market } = setupMarket(60_000_000);
    const alice = store.upsertUser("alice", 1000);
    buyYes(alice, market, 100);

    const dex = new MockProvider("dexscreener", { seed: 81 })
      .setMarketCap(72_000_000)
      .setLiquidity(80_000)
      .setVolume24h(2_000); // below $10k floor
    const gecko = new MockProvider("geckoterminal", { seed: 82 })
      .setMarketCap(72_000_000)
      .setLiquidity(80_000)
      .setVolume24h(2_000);

    const receipt = await settleMarket({
      market,
      coin: TROLL,
      providers: [dex, gecko],
      users: store.users,
    });
    expect(receipt.outcome).toBe("VOID");
    expect(receipt.voidReason).toBe("volume_below_floor");
  });

  it("voids on no_opposition: only YES holders, oracle is fine, refunds cost basis", async () => {
    const { store, market } = setupMarket(60_000_000);
    const alice = store.upsertUser("alice", 1000);
    const aliceBuy = buyYes(alice, market, 100);
    const balanceAfterBuy = alice.trollBalance;
    expect(aliceBuy.quote.shares).toBeGreaterThan(0);

    // Healthy oracle data with clear YES outcome — but no NO opposition exists.
    // The brain MUST refuse to settle as YES (escrow can't fund shares × 1.0)
    // and instead VOID with no_opposition.
    const dex = new MockProvider("dexscreener", { seed: 11 })
      .setMarketCap(80_000_000) // way above 60M target — would normally be YES
      .setLiquidity(80_000)
      .setVolume24h(150_000);
    const gecko = new MockProvider("geckoterminal", { seed: 12 })
      .setMarketCap(80_300_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);

    const receipt = await settleMarket({
      market,
      coin: TROLL,
      providers: [dex, gecko],
      users: store.users,
    });

    expect(receipt.outcome).toBe("VOID");
    expect(receipt.voidReason).toBe("no_opposition");

    // Alice gets her cost basis (100 TROLL) refunded — NOT shares × 1.0.
    expect(alice.trollBalance).toBeCloseTo(balanceAfterBuy + 100, 6);
    const alicePos = market.positions[0]!;
    expect(alicePos.status).toBe("void_refunded");
  });

  it("voids on no_opposition: only NO holders, treats symmetrically", async () => {
    const { store, market } = setupMarket(60_000_000);
    const alice = store.upsertUser("alice", 1000);
    buyNo(alice, market, 50);
    const balanceAfterBuy = alice.trollBalance;

    // Oracle says NO would have won — still must void.
    const dex = new MockProvider("dexscreener", { seed: 21 })
      .setMarketCap(40_000_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);
    const gecko = new MockProvider("geckoterminal", { seed: 22 })
      .setMarketCap(40_300_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);

    const receipt = await settleMarket({
      market,
      coin: TROLL,
      providers: [dex, gecko],
      users: store.users,
    });

    expect(receipt.outcome).toBe("VOID");
    expect(receipt.voidReason).toBe("no_opposition");
    expect(alice.trollBalance).toBeCloseTo(balanceAfterBuy + 50, 6);
  });
});

describe("void refunds preserve cost basis on partially-exited positions", () => {
  it("refunds remaining cost basis, not original spend", async () => {
    const { store, market } = setupMarket(60_000_000);
    const alice = store.upsertUser("alice", 1000);

    // Alice buys 100 TROLL, then sells half her shares before lock.
    const buy = buyYes(alice, market, 100);
    // After the sell, position.costBasisTroll is HALF of 100.
    const { sellYes } = await import("../market/tradeEngine");
    sellYes(alice, market, buy.quote.shares / 2);
    const pos = market.positions[0]!;
    expect(pos.costBasisTroll).toBeCloseTo(50, 6);
    const balanceBeforeSettle = alice.trollBalance;

    // Force a void.
    const dex = new MockProvider("dexscreener", { seed: 91 })
      .setMarketCap(70_000_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);
    const gecko = new MockProvider("geckoterminal", { seed: 92 })
      .setMarketCap(74_000_000) // > 2.5% disagreement → void
      .setLiquidity(80_000)
      .setVolume24h(150_000);

    const receipt = await settleMarket({
      market,
      coin: TROLL,
      providers: [dex, gecko],
      users: store.users,
    });

    expect(receipt.outcome).toBe("VOID");
    // Refund equals REMAINING cost basis (50), not original spend (100).
    expect(alice.trollBalance).toBeCloseTo(balanceBeforeSettle + 50, 6);
    expect(pos.status).toBe("void_refunded");
  });
});

describe("resolver pure-function behavior", () => {
  function buildSnapshots(
    market: Market,
    dexValues: number[],
    geckoValues: number[],
  ): Snapshot[] {
    const snaps: Snapshot[] = [];
    let t = market.closeAt.getTime() - 15_000;
    for (let i = 0; i < Math.max(dexValues.length, geckoValues.length); i++) {
      if (i < dexValues.length) {
        snaps.push(snap("dexscreener", t, dexValues[i]!));
      }
      if (i < geckoValues.length) {
        snaps.push(snap("geckoterminal", t, geckoValues[i]!));
      }
      t += 5_000;
    }
    return snaps;
  }
  function snap(
    source: "dexscreener" | "geckoterminal",
    timeMs: number,
    mc: number,
  ): Snapshot {
    return {
      source,
      fetchedAt: new Date(timeMs),
      marketCapUsd: mc,
      priceUsd: null,
      liquidityUsd: 80_000,
      volume24hUsd: 150_000,
      ok: true,
      errorText: null,
      rawPayload: { mc },
    };
  }

  it("computes canonical MC as average of source medians", () => {
    const { store, market } = setupMarket(60_000_000);
    // Need positions on both sides so resolve() doesn't short-circuit to
    // VOID(no_opposition).  The resolver math is what's under test here —
    // not the opposition guard.
    const alice = store.upsertUser("alice", 1000);
    const bob = store.upsertUser("bob", 1000);
    buyYes(alice, market, 50);
    buyNo(bob, market, 50);
    const snapshots = buildSnapshots(
      market,
      [70e6, 71e6, 72e6, 73e6, 74e6],
      [70e6, 71e6, 72e6, 73e6, 74e6],
    );
    const input: ResolverInput = {
      market,
      snapshots,
      minLiquidityUsd: 25_000,
      minVolume24hUsd: 10_000,
      sourceDisagreementThreshold: 0.025,
      deadZoneThreshold: 0.001,
      minSnapshotsPerSource: 4,
    };
    const out = resolve(input);
    expect(out.outcome).toBe("YES");
    expect(out.canonicalMc).toBeCloseTo(72e6, 6);
    expect(out.perSourceMedian.dexscreener).toBeCloseTo(72e6, 6);
    expect(out.perSourceMedian.geckoterminal).toBeCloseTo(72e6, 6);
  });
});
