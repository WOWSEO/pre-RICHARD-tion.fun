import { describe, it, expect } from "vitest";
import {
  newAmmState,
  getRawPrices,
  getPrices,
  getPricesCents,
  cost,
  costToTrade,
  sharesForBuy,
  applyBuy,
  payoutMultiplierForBuy,
  MIN_PRICE,
  MAX_PRICE,
  PARIMUTUEL_SENTINEL_B,
} from "../market/pricingEngine";
import type { AmmState, Market } from "../market/marketTypes";

/**
 * v52 — parimutuel pricing engine tests.
 *
 * Replaces the LMSR-era tests.  The new engine is a pure parimutuel
 * pool: prices are pool ratios, "shares" are stake units, settlement is
 * share-of-loser-pool.
 */

function makeMarket(state: AmmState): Market {
  return {
    id: "test",
    symbol: "TROLL",
    question: "test",
    targetMc: 0,
    closeAt: new Date(),
    lockAt: new Date(),
    windowSeconds: 30,
    pollCadenceSeconds: 5,
    scheduleType: "15m",
    status: "open",
    amm: state,
    yesPriceCents: 50,
    noPriceCents: 50,
    yesLiquidity: 0,
    noLiquidity: 0,
    volume: 0,
    openInterest: 0,
    settlementMc: null,
    outcome: null,
    voidReason: null,
    positions: [],
    trades: [],
    createdAt: new Date(),
    closedAt: null,
  };
}

describe("parimutuel core", () => {
  it("newAmmState starts with empty pools and sentinel b=0", () => {
    const s = newAmmState();
    expect(s.qYes).toBe(0);
    expect(s.qNo).toBe(0);
    expect(s.b).toBe(PARIMUTUEL_SENTINEL_B);
  });

  it("empty market returns 50/50 raw prices", () => {
    const s = newAmmState();
    const p = getRawPrices(s);
    expect(p.yes).toBeCloseTo(0.5, 9);
    expect(p.no).toBeCloseTo(0.5, 9);
  });

  it("pool ratio drives display prices", () => {
    const s: AmmState = { qYes: 75, qNo: 25, b: 0 };
    const p = getRawPrices(s);
    expect(p.yes).toBeCloseTo(0.75, 9);
    expect(p.no).toBeCloseTo(0.25, 9);
  });

  it("getPrices clamps to [1, 99]¢ symmetrically", () => {
    const skewed: AmmState = { qYes: 1000, qNo: 0, b: 0 };
    const p = getPrices(skewed);
    expect(p.yes).toBe(MAX_PRICE);
    expect(p.no).toBe(MIN_PRICE);
    expect(p.yes + p.no).toBeCloseTo(1.0, 9);
  });

  it("YES + NO sums to 100¢ across many states", () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [10, 90],
      [33, 67],
      [50, 50],
      [99, 1],
    ];
    for (const [qy, qn] of cases) {
      const s: AmmState = { qYes: qy, qNo: qn, b: 0 };
      const c = getPricesCents(s);
      expect(c.yes + c.no).toBeCloseTo(100, 6);
    }
  });

  it("costToTrade equals the stake amount (1:1)", () => {
    const s = newAmmState();
    expect(costToTrade(s, "YES", 100)).toBe(100);
    expect(costToTrade(s, "NO", 250)).toBe(250);
    expect(costToTrade(s, "YES", -50)).toBe(0);
  });

  it("sharesForBuy returns the stake amount (1:1)", () => {
    const s = newAmmState();
    expect(sharesForBuy(s, "YES", 100)).toBe(100);
    expect(sharesForBuy(s, "NO", 0)).toBe(0);
  });

  it("applyBuy adds to the correct pool", () => {
    const s = newAmmState();
    const after = applyBuy(s, "YES", 50);
    expect(after.qYes).toBe(50);
    expect(after.qNo).toBe(0);
    const after2 = applyBuy(after, "NO", 30);
    expect(after2.qYes).toBe(50);
    expect(after2.qNo).toBe(30);
  });

  it("cost() back-compat returns total pool size", () => {
    const s: AmmState = { qYes: 30, qNo: 70, b: 0 };
    expect(cost(s)).toBe(100);
  });
});

describe("parimutuel price movement", () => {
  it("buying YES pushes YES price up", () => {
    let s = newAmmState();
    s = applyBuy(s, "YES", 100);
    s = applyBuy(s, "NO", 100);
    const before = getRawPrices(s).yes;
    s = applyBuy(s, "YES", 50);
    const after = getRawPrices(s).yes;
    expect(after).toBeGreaterThan(before);
  });

  it("buying NO pushes NO price up", () => {
    let s = newAmmState();
    s = applyBuy(s, "YES", 100);
    s = applyBuy(s, "NO", 100);
    const before = getRawPrices(s).no;
    s = applyBuy(s, "NO", 50);
    const after = getRawPrices(s).no;
    expect(after).toBeGreaterThan(before);
  });

  it("buying YES pushes NO price down by exactly the same amount (zero-sum)", () => {
    let s = newAmmState();
    s = applyBuy(s, "YES", 100);
    s = applyBuy(s, "NO", 100);
    const before = getRawPrices(s);
    s = applyBuy(s, "YES", 50);
    const after = getRawPrices(s);
    const yesDelta = after.yes - before.yes;
    const noDelta = after.no - before.no;
    expect(yesDelta).toBeCloseTo(-noDelta, 9);
  });
});

describe("payout multiplier", () => {
  it("balanced market: betting on either side yields ~2x", () => {
    let s = newAmmState();
    s = applyBuy(s, "YES", 1000);
    s = applyBuy(s, "NO", 1000);
    const m = makeMarket(s);
    const yesMult = payoutMultiplierForBuy(m, "YES", 1);
    const noMult = payoutMultiplierForBuy(m, "NO", 1);
    expect(yesMult).toBeCloseTo(2.0, 1);
    expect(noMult).toBeCloseTo(2.0, 1);
  });

  it("favorite (heavy side) yields lower multiplier", () => {
    let s = newAmmState();
    s = applyBuy(s, "YES", 900);
    s = applyBuy(s, "NO", 100);
    const m = makeMarket(s);
    const yesMult = payoutMultiplierForBuy(m, "YES", 10);
    const noMult = payoutMultiplierForBuy(m, "NO", 10);
    expect(yesMult).toBeLessThan(1.5);
    expect(noMult).toBeGreaterThan(5.0);
  });

  it("empty market: betting alone gives ~1x (no upside if no opponent)", () => {
    const s = newAmmState();
    const m = makeMarket(s);
    const mult = payoutMultiplierForBuy(m, "YES", 100);
    expect(mult).toBeCloseTo(1.0, 6);
  });
});
