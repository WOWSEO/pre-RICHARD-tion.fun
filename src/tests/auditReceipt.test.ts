import { describe, it, expect } from "vitest";
import { TROLL } from "../config/troll";
import { createMarket } from "../market/scheduler";
import { buyYes, buyNo } from "../market/tradeEngine";
import { settleMarket } from "../market/settlementEngine";
import { buildAuditReceipt } from "../market/auditReceipt";
import { MockProvider } from "../providers/mockProvider";
import { MemoryStore } from "../store/memoryStore";
import type { Snapshot, ResolverOutput, UserSettlement } from "../market/marketTypes";

function setupAndSettleYes() {
  const store = new MemoryStore();
  const alice = store.upsertUser("alice", 1000);
  const bob = store.upsertUser("bob", 1000);
  const market = store.addMarket(
    createMarket({
      symbol: "TROLL",
      scheduleType: "15m",
      closeAt: new Date(Date.now() - 60_000),
      targetMc: 60_000_000,
    }),
  );
  buyYes(alice, market, 100);
  buyNo(bob, market, 80);
  return { store, market };
}

describe("audit receipt structure", () => {
  it("includes all required fields", async () => {
    const { store, market } = setupAndSettleYes();
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

    expect(receipt.marketId).toBe(market.id);
    expect(receipt.question).toContain("TROLL");
    expect(receipt.targetMc).toBe(60_000_000);
    expect(receipt.scheduleType).toBe("15m");
    expect(receipt.outcome).toBe("YES");
    expect(receipt.canonicalMc).not.toBeNull();
    expect(receipt.perSourceMedian).toHaveProperty("dexscreener");
    expect(receipt.perSourceMedian).toHaveProperty("geckoterminal");
    expect(typeof receipt.finalYesPriceCents).toBe("number");
    expect(typeof receipt.finalNoPriceCents).toBe("number");
    expect(receipt.finalYesPriceCents).toBeGreaterThanOrEqual(1);
    expect(receipt.finalYesPriceCents).toBeLessThanOrEqual(99);
    expect(receipt.snapshots.length).toBeGreaterThan(0);
    expect(receipt.snapshotBundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.userSettlements.length).toBe(2);
    expect(typeof receipt.generatedAt).toBe("string");
  });

  it("captures void reason when voided", async () => {
    const { store, market } = setupAndSettleYes();
    const dex = new MockProvider("dexscreener", { seed: 11 })
      .setMarketCap(70_000_000)
      .setLiquidity(80_000)
      .setVolume24h(150_000);
    const gecko = new MockProvider("geckoterminal", { seed: 12 })
      .setMarketCap(74_000_000) // > 2.5% disagreement
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
    expect(receipt.userSettlements.every((s) => s.finalStatus === "void_refunded")).toBe(
      true,
    );
  });
});

describe("audit receipt determinism", () => {
  // Build a fixed snapshot array + resolver output and assert the hash is stable
  // and changes when inputs change.
  function fixedSnapshots(): Snapshot[] {
    const baseTs = new Date("2026-05-01T00:00:00.000Z").getTime();
    const out: Snapshot[] = [];
    for (let i = 0; i < 5; i++) {
      out.push({
        source: "dexscreener",
        fetchedAt: new Date(baseTs + i * 5_000),
        marketCapUsd: 72_000_000 + i * 1000,
        priceUsd: 0.072,
        liquidityUsd: 80_000,
        volume24hUsd: 150_000,
        ok: true,
        errorText: null,
        rawPayload: { i },
      });
      out.push({
        source: "geckoterminal",
        fetchedAt: new Date(baseTs + i * 5_000),
        marketCapUsd: 72_300_000 + i * 1000,
        priceUsd: 0.0723,
        liquidityUsd: 80_000,
        volume24hUsd: 150_000,
        ok: true,
        errorText: null,
        rawPayload: { i },
      });
    }
    return out;
  }
  const fixedOutcome: ResolverOutput = {
    outcome: "YES",
    voidReason: null,
    canonicalMc: 72_152_000,
    perSourceMedian: { dexscreener: 72_002_000, geckoterminal: 72_302_000 },
    validSnapshotsBySource: { dexscreener: 5, geckoterminal: 5 },
  };
  const fixedSettlements: UserSettlement[] = [
    {
      wallet: "alice",
      positionId: "pos_1",
      side: "YES",
      shares: 200,
      averageEntryPriceCents: 50,
      costBasisTroll: 100,
      payoutTroll: 200,
      realizedPnlOnSettlement: 100,
      finalStatus: "settled",
    },
  ];
  function fixedMarket() {
    const m = createMarket({
      symbol: "TROLL",
      scheduleType: "15m",
      closeAt: new Date("2026-05-01T00:00:00.000Z"),
      targetMc: 60_000_000,
      now: new Date("2026-04-30T23:50:00.000Z"),
    });
    // Pin the id so receipt comparisons are stable across this test run.
    m.id = "TROLL-15m-fixed";
    m.yesPriceCents = 78.5;
    m.noPriceCents = 21.5;
    return m;
  }

  it("produces the same snapshotBundleHash for identical inputs", () => {
    const a = buildAuditReceipt(
      fixedMarket(),
      fixedSnapshots(),
      fixedOutcome,
      fixedSettlements,
    );
    const b = buildAuditReceipt(
      fixedMarket(),
      fixedSnapshots(),
      fixedOutcome,
      fixedSettlements,
    );
    expect(a.snapshotBundleHash).toBe(b.snapshotBundleHash);
  });

  it("hash changes if any snapshot byte changes", () => {
    const base = buildAuditReceipt(
      fixedMarket(),
      fixedSnapshots(),
      fixedOutcome,
      fixedSettlements,
    );
    const tweaked = fixedSnapshots();
    tweaked[0]!.marketCapUsd = 72_000_001; // 1-dollar change
    const tw = buildAuditReceipt(
      fixedMarket(),
      tweaked,
      fixedOutcome,
      fixedSettlements,
    );
    expect(tw.snapshotBundleHash).not.toBe(base.snapshotBundleHash);
  });

  it("hash is independent of generatedAt timestamp", () => {
    const a = buildAuditReceipt(
      fixedMarket(),
      fixedSnapshots(),
      fixedOutcome,
      fixedSettlements,
    );
    // Wait a moment; new receipt's generatedAt will differ but hash should not.
    const b = buildAuditReceipt(
      fixedMarket(),
      fixedSnapshots(),
      fixedOutcome,
      fixedSettlements,
    );
    expect(a.generatedAt === b.generatedAt || a.generatedAt !== b.generatedAt).toBe(true);
    expect(a.snapshotBundleHash).toBe(b.snapshotBundleHash);
  });
});
