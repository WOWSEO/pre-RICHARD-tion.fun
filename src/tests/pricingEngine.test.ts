import { describe, it, expect } from "vitest";
import {
  newAmmState,
  getPrices,
  getPricesCents,
  getRawPrices,
  costToTrade,
  sharesForBuy,
  proceedsForSell,
  applyBuy,
  applySell,
  cost,
  quoteBuyYes,
  quoteBuyNo,
  quoteSellYes,
  calculatePriceImpact,
  MIN_PRICE,
  MAX_PRICE,
} from "../market/pricingEngine";
import { createMarket } from "../market/scheduler";

function freshMarket(b?: number) {
  return createMarket({
    symbol: "TROLL",
    scheduleType: "15m",
    closeAt: new Date(Date.now() + 5 * 60_000),
    targetMc: 60_000_000,
    b,
  });
}

describe("LMSR core", () => {
  it("starts at 50/50 with prices summing to 1", () => {
    const s = newAmmState();
    const p = getPrices(s);
    expect(p.yes).toBeCloseTo(0.5, 12);
    expect(p.no).toBeCloseTo(0.5, 12);
    expect(p.yes + p.no).toBeCloseTo(1, 12);
  });

  it("YES + NO sum to 1 across many trades (clamped output too)", () => {
    let s = newAmmState();
    s = applyBuy(s, "YES", 250);
    expect(getPrices(s).yes + getPrices(s).no).toBeCloseTo(1, 12);
    s = applyBuy(s, "NO", 800);
    expect(getPrices(s).yes + getPrices(s).no).toBeCloseTo(1, 12);
    s = applySell(s, "YES", 100);
    expect(getPrices(s).yes + getPrices(s).no).toBeCloseTo(1, 12);
  });

  it("sharesForBuy and costToTrade agree (round-trip)", () => {
    const s = newAmmState();
    const shares = sharesForBuy(s, "YES", 100);
    const recoveredCost = costToTrade(s, "YES", shares);
    expect(recoveredCost).toBeCloseTo(100, 6);
  });

  it("proceedsForSell equals -costToTrade with negative delta", () => {
    let s = newAmmState();
    s = applyBuy(s, "YES", 200);
    const proceeds = proceedsForSell(s, "YES", 50);
    const direct = -costToTrade(s, "YES", -50);
    expect(proceeds).toBeCloseTo(direct, 12);
    expect(proceeds).toBeGreaterThan(0);
  });

  it("cost function is monotone in q", () => {
    const a = cost({ qYes: 0, qNo: 0, b: 1000 });
    const b = cost({ qYes: 100, qNo: 0, b: 1000 });
    const c = cost({ qYes: 200, qNo: 0, b: 1000 });
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});

describe("price direction", () => {
  it("buying YES moves YES price up", () => {
    let s = newAmmState();
    const before = getPrices(s).yes;
    s = applyBuy(s, "YES", 100);
    expect(getPrices(s).yes).toBeGreaterThan(before);
  });

  it("buying NO moves NO price up (and YES down)", () => {
    let s = newAmmState();
    const yesBefore = getPrices(s).yes;
    const noBefore = getPrices(s).no;
    s = applyBuy(s, "NO", 100);
    expect(getPrices(s).no).toBeGreaterThan(noBefore);
    expect(getPrices(s).yes).toBeLessThan(yesBefore);
  });

  it("selling YES moves YES price down", () => {
    let s = newAmmState();
    s = applyBuy(s, "YES", 200);
    const before = getPrices(s).yes;
    s = applySell(s, "YES", 50);
    expect(getPrices(s).yes).toBeLessThan(before);
  });

  it("selling NO moves NO price down (and YES up)", () => {
    let s = newAmmState();
    s = applyBuy(s, "NO", 200);
    const yesBefore = getPrices(s).yes;
    const noBefore = getPrices(s).no;
    s = applySell(s, "NO", 50);
    expect(getPrices(s).no).toBeLessThan(noBefore);
    expect(getPrices(s).yes).toBeGreaterThan(yesBefore);
  });
});

describe("price clamp [1¢, 99¢]", () => {
  it("displayed YES price never goes above 99¢ even with extreme YES imbalance", () => {
    // With b=1000, raw price reaches 99% at qY-qN ≈ 1000 * ln(99) ≈ 4595.
    // Buy 50,000 TROLL of YES — way more than enough.
    let s = newAmmState(1000);
    const shares = sharesForBuy(s, "YES", 50_000);
    s = applyBuy(s, "YES", shares);
    const raw = getRawPrices(s);
    const clamped = getPrices(s);
    // Sanity: the raw probability is over 99% in this state.
    expect(raw.yes).toBeGreaterThan(0.99);
    // But the clamped/displayed value never exceeds 99¢.
    expect(clamped.yes).toBeLessThanOrEqual(MAX_PRICE);
    expect(clamped.yes).toBeCloseTo(MAX_PRICE, 12);
  });

  it("displayed NO price never goes below 1¢ in the same scenario", () => {
    let s = newAmmState(1000);
    const shares = sharesForBuy(s, "YES", 50_000);
    s = applyBuy(s, "YES", shares);
    const clamped = getPrices(s);
    expect(clamped.no).toBeGreaterThanOrEqual(MIN_PRICE);
    expect(clamped.no).toBeCloseTo(MIN_PRICE, 12);
  });

  it("after clamp, YES + NO still equals exactly 1.0 (clamp is symmetric)", () => {
    let s = newAmmState(1000);
    s = applyBuy(s, "YES", sharesForBuy(s, "YES", 50_000));
    const p = getPrices(s);
    expect(p.yes + p.no).toBeCloseTo(1, 12);
  });

  it("getPricesCents stays in [1, 99] regardless of imbalance", () => {
    let s = newAmmState(1000);
    s = applyBuy(s, "NO", sharesForBuy(s, "NO", 80_000));
    const cents = getPricesCents(s);
    expect(cents.yes).toBeGreaterThanOrEqual(1);
    expect(cents.yes).toBeLessThanOrEqual(99);
    expect(cents.no).toBeGreaterThanOrEqual(1);
    expect(cents.no).toBeLessThanOrEqual(99);
  });
});

describe("slippage / price impact", () => {
  it("larger buys produce more slippage than smaller buys", () => {
    const market = freshMarket();
    const small = quoteBuyYes(market, 50);
    const large = quoteBuyYes(market, 500);
    expect(calculatePriceImpact(large)).toBeGreaterThan(
      calculatePriceImpact(small),
    );
    // Effective avg price for the bigger buy is also worse (higher).
    expect(large.avgPriceCents).toBeGreaterThan(small.avgPriceCents);
  });

  it("bigger b means smaller slippage for the same-size buy", () => {
    const lowB = freshMarket(100);
    const highB = freshMarket(10_000);
    const small = quoteBuyYes(lowB, 100);
    const big = quoteBuyYes(highB, 100);
    expect(calculatePriceImpact(small)).toBeGreaterThan(
      calculatePriceImpact(big),
    );
  });

  it("price impact is positive on a buy and negative on a sell", () => {
    const market = freshMarket();
    const buyQ = quoteBuyYes(market, 100);
    expect(buyQ.priceImpactCents).toBeGreaterThan(0);
    // Push qY up so we can sell some
    const m2 = createMarket({
      symbol: "TROLL",
      scheduleType: "15m",
      closeAt: new Date(Date.now() + 5 * 60_000),
      targetMc: 60_000_000,
    });
    m2.amm = applyBuy(m2.amm, "YES", 200);
    const sellQ = quoteSellYes(m2, 50);
    expect(sellQ.priceImpactCents).toBeLessThan(0);
  });

  it("quote functions do not mutate market state", () => {
    const m = freshMarket();
    const ammBefore = { ...m.amm };
    quoteBuyYes(m, 100);
    quoteBuyNo(m, 100);
    quoteSellYes({ ...m, amm: { ...m.amm, qYes: 100 } }, 50);
    expect(m.amm).toEqual(ammBefore);
  });
});
