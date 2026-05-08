import { describe, it, expect } from "vitest";
import { TROLL } from "../config/troll";
import { createMarket } from "../market/scheduler";
import { buyYes, buyNo, sellYes, sellNo } from "../market/tradeEngine";
import {
  resolve,
  applyPayouts,
  PLATFORM_FEE_RATE,
} from "../market/settlementEngine";
import type { ResolverInput, Snapshot, Market, ResolverOutput } from "../market/marketTypes";
import { MemoryStore } from "../store/memoryStore";

/**
 * v52 — End-to-end parimutuel tests.
 *
 * Replaces the LMSR-era settlementEngine.test.ts and (selectively) tradeEngine.test.ts.
 * Covers:
 *
 *   - buy adds to pool, 1:1
 *   - sell is blocked (parimutuel positions are locked)
 *   - payout multiplier slippage rail
 *   - winner payout math = stake × (totalPool / winnerPool) × (1 - fee)
 *   - loser gets $0
 *   - void refunds full stake (no fee)
 *   - conservation: net winner payouts + platform fee = total pool
 */

function makeMarket(targetMc: number = 50_000_000): {
  store: MemoryStore;
  market: Market;
} {
  const store = new MemoryStore();
  const market = store.addMarket(
    createMarket({
      symbol: "TROLL",
      scheduleType: "15m",
      closeAt: new Date(Date.now() - 60_000),
      targetMc,
    }),
  );
  return { store, market };
}

function makeSnapshots(
  mc: number,
  source: "dexscreener" | "geckoterminal",
  count = 5,
): Snapshot[] {
  const out: Snapshot[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      source,
      ok: true,
      marketCapUsd: mc,
      priceUsd: mc / 1_000_000_000,
      liquidityUsd: 100_000,
      volume24hUsd: 150_000,
      fetchedAt: new Date(Date.now() - 60_000 + i * 1000),
      errorText: null,
      rawPayload: {},
    });
  }
  return out;
}

function defaultResolverInput(market: Market, snapshots: Snapshot[]): ResolverInput {
  return {
    market,
    snapshots,
    minLiquidityUsd: TROLL.minLiquidityUsd ?? 25_000,
    minVolume24hUsd: TROLL.minVolume24hUsd ?? 10_000,
    sourceDisagreementThreshold: 0.025,
    deadZoneThreshold: 0.001,
    minSnapshotsPerSource: 4,
  };
}

function makeYesWinSnapshots(): Snapshot[] {
  return [
    ...makeSnapshots(60_000_000, "dexscreener"),
    ...makeSnapshots(60_000_000, "geckoterminal"),
  ];
}

function makeNoWinSnapshots(): Snapshot[] {
  return [
    ...makeSnapshots(40_000_000, "dexscreener"),
    ...makeSnapshots(40_000_000, "geckoterminal"),
  ];
}

// ====================================================================
// Trade engine — parimutuel buy semantics
// ====================================================================

describe("parimutuel buy", () => {
  it("buy adds stake to YES pool 1:1", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);

    expect(market.amm.qYes).toBe(0);
    buyYes(alice, market, 100);
    expect(market.amm.qYes).toBe(100);
    expect(market.amm.qNo).toBe(0);
  });

  it("buy debits user balance by stake amount", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);

    buyYes(alice, market, 250);
    expect(alice.trollBalance).toBe(750);
  });

  it("position records stake as both shares and costBasis", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);

    const receipt = buyYes(alice, market, 250);
    const pos = market.positions.find((p) => p.wallet === "alice")!;
    expect(pos.shares).toBe(250);
    expect(pos.costBasisTroll).toBe(250);
    expect(receipt.quote.shares).toBe(250);
    expect(receipt.quote.trollAmount).toBe(250);
  });

  it("buying YES pushes displayed YES price up", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);
    const bob = store.upsertUser("bob", 1000);

    buyYes(alice, market, 100);
    buyNo(bob, market, 100);
    const beforeYes = market.yesPriceCents;
    buyYes(alice, market, 50);
    expect(market.yesPriceCents).toBeGreaterThan(beforeYes);
  });

  it("YES + NO prices always sum to 100¢", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 10_000);
    const bob = store.upsertUser("bob", 10_000);

    buyYes(alice, market, 100);
    expect(market.yesPriceCents + market.noPriceCents).toBeCloseTo(100, 6);
    buyNo(bob, market, 250);
    expect(market.yesPriceCents + market.noPriceCents).toBeCloseTo(100, 6);
    buyYes(alice, market, 50);
    expect(market.yesPriceCents + market.noPriceCents).toBeCloseTo(100, 6);
  });
});

describe("parimutuel exit-at-cost-basis (v54.4)", () => {
  it("full exit refunds stake, removes position from pool, marks position closed", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);
    buyYes(alice, market, 100);
    expect(market.amm.qYes).toBe(100);

    // Alice has 100 shares (= 100 stake) on YES.  Full exit.
    const r = sellYes(alice, market, 100);

    expect(r.quote.trollAmount).toBeCloseTo(100, 6);
    expect(market.amm.qYes).toBeCloseTo(0, 6);
    const pos = market.positions.find((p) => p.wallet === "alice" && p.side === "YES")!;
    expect(pos.shares).toBe(0);
    expect(pos.costBasisTroll).toBe(0);
    expect(pos.status).toBe("closed");
  });

  it("partial exit refunds proportional stake, leaves the rest open", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);
    buyYes(alice, market, 100);

    // Exit half.
    const r = sellYes(alice, market, 50);

    expect(r.quote.trollAmount).toBeCloseTo(50, 6);
    expect(market.amm.qYes).toBeCloseTo(50, 6);
    const pos = market.positions.find((p) => p.wallet === "alice" && p.side === "YES")!;
    expect(pos.shares).toBeCloseTo(50, 6);
    expect(pos.costBasisTroll).toBeCloseTo(50, 6);
    expect(pos.status).toBe("open");
  });

  it("exit decreases pool, shifting odds for remaining participants", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);
    const bob = store.upsertUser("bob", 1000);
    buyYes(alice, market, 100);
    buyNo(bob, market, 100);

    // 50/50 split before exit.
    expect(market.yesPriceCents).toBe(50);
    expect(market.noPriceCents).toBe(50);

    // Bob exits.  YES is now the entire pool.
    sellNo(bob, market, 100);
    expect(market.amm.qNo).toBeCloseTo(0, 6);
    expect(market.yesPriceCents).toBe(99); // displayed-clamped from 100
    expect(market.noPriceCents).toBe(1);
  });

  it("exit on closed market throws", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);
    buyYes(alice, market, 100);
    market.status = "locked";
    expect(() => sellYes(alice, market, 100)).toThrow(/not open/);
  });

  it("exit more than held throws", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);
    buyYes(alice, market, 100);
    expect(() => sellYes(alice, market, 200)).toThrow(/has only 100/);
  });

  it("exit on a side with no position throws", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);
    buyYes(alice, market, 100);
    expect(() => sellNo(alice, market, 50)).toThrow(/no open NO position/);
  });

  it("does NOT bump market.volume on exit (volume tracks new bets, not gross turnover)", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);
    buyYes(alice, market, 100);
    const volBefore = market.volume;
    sellYes(alice, market, 50);
    expect(market.volume).toBe(volBefore);
  });
});

describe("payout multiplier slippage rail", () => {
  it("rejects buy when implied multiplier is below the user's minimum", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);
    const bob = store.upsertUser("bob", 1000);

    // alice bets heavy YES, making YES the favorite
    buyYes(alice, market, 900);
    buyNo(bob, market, 100);

    // Now alice tries to bet MORE on YES.  Her multiplier would be very low
    // (she's piling onto the favorite).  If she demands ≥ 2x, the trade
    // should reject.
    expect(() => buyYes(alice, market, 50, undefined, 2.0)).toThrow(/multiplier/);
  });

  it("allows buy when multiplier meets the minimum", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 1000);
    const bob = store.upsertUser("bob", 1000);

    buyYes(alice, market, 100);
    buyNo(bob, market, 100);

    // Balanced market — alice betting NO (the slightly-bigger pool by 1¢)
    // should give close to 2x.  Demand ≥ 1.5x: should pass.
    expect(() => buyNo(bob, market, 10, undefined, 1.5)).not.toThrow();
  });

  it("default behavior unchanged — no multiplier means no rejection", () => {
    const { store, market } = makeMarket();
    const alice = store.upsertUser("alice", 10_000);
    const bob = store.upsertUser("bob", 10_000);

    buyYes(alice, market, 5000);
    // Even though YES is heavy, no slippage cap means this still goes through
    expect(() => buyYes(bob, market, 100)).not.toThrow();
  });
});

// ====================================================================
// Settlement — parimutuel payouts
// ====================================================================

describe("parimutuel settlement — YES wins", () => {
  it("pays winners stake × (totalPool / yesPool) × (1 - fee)", () => {
    const { store, market } = makeMarket(50_000_000);
    const alice = store.upsertUser("alice", 1000);
    const bob = store.upsertUser("bob", 1000);

    buyYes(alice, market, 100); // YES pool = 100
    buyNo(bob, market, 200);    // NO pool = 200, total = 300

    const aliceBalanceBefore = alice.trollBalance;
    const bobBalanceBefore = bob.trollBalance;

    const outcome = resolve(
      defaultResolverInput(market, makeYesWinSnapshots()),
    );
    expect(outcome.outcome).toBe("YES");

    const settlements = applyPayouts(market, store.users, outcome);
    expect(settlements).toHaveLength(2);

    // Alice (YES winner): stake $100, yesPool $100, totalPool $300
    //   gross = 100 * (300/100) = 300
    //   net   = 300 * 0.97 = 291
    const aliceSettlement = settlements.find((s) => s.wallet === "alice")!;
    expect(aliceSettlement.payoutTroll).toBeCloseTo(300 * (1 - PLATFORM_FEE_RATE), 4);
    expect(alice.trollBalance).toBeCloseTo(
      aliceBalanceBefore + 300 * (1 - PLATFORM_FEE_RATE),
      4,
    );

    // Bob (NO loser): payout = 0
    const bobSettlement = settlements.find((s) => s.wallet === "bob")!;
    expect(bobSettlement.payoutTroll).toBe(0);
    expect(bob.trollBalance).toBe(bobBalanceBefore);
  });

  it("conservation: net winner payouts + platform fee = total pool", () => {
    const { store, market } = makeMarket(50_000_000);
    const alice = store.upsertUser("alice", 10_000);
    const bob = store.upsertUser("bob", 10_000);
    const carol = store.upsertUser("carol", 10_000);

    buyYes(alice, market, 100);
    buyYes(carol, market, 200); // YES pool = 300
    buyNo(bob, market, 500);    // NO pool = 500, total = 800

    const outcome = resolve(
      defaultResolverInput(market, makeYesWinSnapshots()),
    );
    const settlements = applyPayouts(market, store.users, outcome);

    const totalPool = 100 + 200 + 500;
    const totalNetPayouts = settlements.reduce((acc, s) => acc + s.payoutTroll, 0);
    const expectedFee = totalPool * PLATFORM_FEE_RATE;

    // Net payouts = pool × (1 - fee). Fee = pool × fee. They sum to pool.
    expect(totalNetPayouts).toBeCloseTo(totalPool * (1 - PLATFORM_FEE_RATE), 4);
    expect(totalNetPayouts + expectedFee).toBeCloseTo(totalPool, 4);
  });

  it("multiple winners split proportionally to stake", () => {
    const { store, market } = makeMarket(50_000_000);
    const alice = store.upsertUser("alice", 10_000);
    const carol = store.upsertUser("carol", 10_000);
    const bob = store.upsertUser("bob", 10_000);

    buyYes(alice, market, 100);
    buyYes(carol, market, 300); // carol staked 3x more than alice
    buyNo(bob, market, 400);    // total pool = 800, yesPool = 400

    const outcome = resolve(
      defaultResolverInput(market, makeYesWinSnapshots()),
    );
    const settlements = applyPayouts(market, store.users, outcome);
    const aliceSettle = settlements.find((s) => s.wallet === "alice")!;
    const carolSettle = settlements.find((s) => s.wallet === "carol")!;

    // Carol staked 3x → carol's payout should be 3x alice's
    expect(carolSettle.payoutTroll).toBeCloseTo(3 * aliceSettle.payoutTroll, 4);
  });
});

describe("parimutuel settlement — NO wins", () => {
  it("pays NO winners proportionally", () => {
    const { store, market } = makeMarket(50_000_000);
    const alice = store.upsertUser("alice", 1000);
    const bob = store.upsertUser("bob", 1000);

    buyYes(alice, market, 200); // YES pool = 200
    buyNo(bob, market, 100);    // NO pool = 100, total = 300

    const outcome = resolve(
      defaultResolverInput(market, makeNoWinSnapshots()),
    );
    expect(outcome.outcome).toBe("NO");

    const settlements = applyPayouts(market, store.users, outcome);
    // Bob (NO winner): stake $100, noPool $100, totalPool $300
    //   gross = 100 * 3 = 300, net = 291
    const bobSettle = settlements.find((s) => s.wallet === "bob")!;
    expect(bobSettle.payoutTroll).toBeCloseTo(300 * (1 - PLATFORM_FEE_RATE), 4);
    // Alice (YES loser): 0
    const aliceSettle = settlements.find((s) => s.wallet === "alice")!;
    expect(aliceSettle.payoutTroll).toBe(0);
  });
});

describe("parimutuel settlement — VOID", () => {
  it("refunds every position its full stake (no fee)", () => {
    const { store, market } = makeMarket(50_000_000);
    const alice = store.upsertUser("alice", 1000);
    buyYes(alice, market, 200);
    // No bob — only YES side, so no_opposition will VOID

    const outcome = resolve(
      defaultResolverInput(market, makeYesWinSnapshots()),
    );
    expect(outcome.outcome).toBe("VOID");
    expect(outcome.voidReason).toBe("no_opposition");

    const settlements = applyPayouts(market, store.users, outcome);
    const aliceSettle = settlements.find((s) => s.wallet === "alice")!;
    expect(aliceSettle.payoutTroll).toBe(200); // full refund, no fee
    expect(aliceSettle.finalStatus).toBe("void_refunded");
    expect(alice.trollBalance).toBe(1000); // back to starting
  });

  it("v54.4 — drained-winner-pool from exits forces VOID, refunds losers", () => {
    // alice bets YES, bob bets NO, alice exits — now only NO has stake.
    // If YES wins, the math would either divide by zero or orphan bob's
    // stake.  The drained-pool guard treats this as VOID.
    const { store, market } = makeMarket(50_000_000);
    const alice = store.upsertUser("alice", 1000);
    const bob = store.upsertUser("bob", 1000);

    buyYes(alice, market, 100);
    buyNo(bob, market, 100);
    sellYes(alice, market, 100); // alice exits, yesPool now 0

    // Force the resolver to say YES wins (oracle-driven; bypass the resolver
    // by hand-crafting an outcome).
    const fakeYesOutcome = {
      outcome: "YES" as const,
      voidReason: null,
      canonicalMc: 999_999_999,
      perSourceMedian: {},
      validSnapshotsBySource: {},
    };
    const settlements = applyPayouts(market, store.users, fakeYesOutcome);

    // Bob (NO holder) gets refunded full stake — VOID treatment, no fee.
    const bobSettle = settlements.find((s) => s.wallet === "bob")!;
    expect(bobSettle.payoutTroll).toBe(100);
    expect(bobSettle.finalStatus).toBe("void_refunded");
  });
});

describe("parimutuel settlement — solvency", () => {
  it("any 1v1 balanced market is solvent (this was the LMSR bug)", () => {
    const { store, market } = makeMarket(50_000_000);
    const alice = store.upsertUser("alice", 1000);
    const bob = store.upsertUser("bob", 1000);

    // The exact scenario that was insolvent under LMSR:
    // alice $200 YES, bob $200 NO, NO wins.
    buyYes(alice, market, 200);
    buyNo(bob, market, 200);

    const outcome = resolve(defaultResolverInput(market, makeNoWinSnapshots()));
    expect(outcome.outcome).toBe("NO");

    const settlements = applyPayouts(market, store.users, outcome);
    // Bob's net payout = $200 * (400/200) * 0.97 = $388
    const bobSettle = settlements.find((s) => s.wallet === "bob")!;
    expect(bobSettle.payoutTroll).toBeCloseTo(400 * (1 - PLATFORM_FEE_RATE), 4);
    // Alice loses
    const aliceSettle = settlements.find((s) => s.wallet === "alice")!;
    expect(aliceSettle.payoutTroll).toBe(0);
    // Conservation
    expect(bobSettle.payoutTroll + 400 * PLATFORM_FEE_RATE).toBeCloseTo(400, 4);
  });

  it("extreme skew still settles cleanly (alice $900 YES, bob $100 NO, YES wins)", () => {
    const { store, market } = makeMarket(50_000_000);
    const alice = store.upsertUser("alice", 10_000);
    const bob = store.upsertUser("bob", 10_000);

    buyYes(alice, market, 900);
    buyNo(bob, market, 100); // total 1000, yesPool=900

    const outcome = resolve(defaultResolverInput(market, makeYesWinSnapshots()));
    const settlements = applyPayouts(market, store.users, outcome);

    // Alice gross = 900 * (1000/900) = 1000.  Net = 970.
    const aliceSettle = settlements.find((s) => s.wallet === "alice")!;
    expect(aliceSettle.payoutTroll).toBeCloseTo(1000 * (1 - PLATFORM_FEE_RATE), 4);
    // Conservation
    const totalPaid = settlements.reduce((s, x) => s + x.payoutTroll, 0);
    expect(totalPaid + 1000 * PLATFORM_FEE_RATE).toBeCloseTo(1000, 4);
  });
});
