import { describe, it, expect } from "vitest";
import {
  buyYes,
  buyNo,
  sellYes,
  sellNo,
} from "../market/tradeEngine";
import {
  calculatePositionValue,
  calculateUnrealizedPnL,
} from "../market/positionEngine";
import {
  createMarket,
  tick,
  windowSecondsFor,
  pollCadenceFor,
  lockOffsetSecondsFor,
  nextQuarterHour,
  nextTopOfHour,
  nextDailyClose,
} from "../market/scheduler";
import { MemoryStore } from "../store/memoryStore";

function setup(closeIn = 5 * 60_000) {
  const store = new MemoryStore();
  const alice = store.upsertUser("alice", 1000);
  const bob = store.upsertUser("bob", 1000);
  const market = store.addMarket(
    createMarket({
      symbol: "TROLL",
      scheduleType: "15m",
      closeAt: new Date(Date.now() + closeIn),
      targetMc: 60_000_000,
    }),
  );
  return { store, alice, bob, market };
}

describe("buy/sell direction", () => {
  it("buyYes increases YES price", () => {
    const { alice, market } = setup();
    const before = market.yesPriceCents;
    buyYes(alice, market, 100);
    expect(market.yesPriceCents).toBeGreaterThan(before);
  });

  it("buyNo increases NO price", () => {
    const { alice, market } = setup();
    const before = market.noPriceCents;
    buyNo(alice, market, 100);
    expect(market.noPriceCents).toBeGreaterThan(before);
  });

  it("sellYes decreases YES price", () => {
    const { alice, market } = setup();
    const r = buyYes(alice, market, 200);
    const before = market.yesPriceCents;
    sellYes(alice, market, r.quote.shares / 2);
    expect(market.yesPriceCents).toBeLessThan(before);
  });

  it("sellNo decreases NO price", () => {
    const { alice, market } = setup();
    const r = buyNo(alice, market, 200);
    const before = market.noPriceCents;
    sellNo(alice, market, r.quote.shares / 2);
    expect(market.noPriceCents).toBeLessThan(before);
  });

  it("YES + NO stays at 100¢ across a complex sequence", () => {
    const { alice, bob, market } = setup();
    buyYes(alice, market, 80);
    buyNo(bob, market, 200);
    const r = buyYes(alice, market, 60);
    sellYes(alice, market, r.quote.shares / 4);
    expect(market.yesPriceCents + market.noPriceCents).toBeCloseTo(100, 8);
  });
});

describe("balance accounting", () => {
  it("buy debits user balance by exactly the amount", () => {
    const { alice, market } = setup();
    const before = alice.trollBalance;
    buyYes(alice, market, 100);
    expect(alice.trollBalance).toBeCloseTo(before - 100, 12);
  });

  it("sell credits user balance by proceeds", () => {
    const { alice, market } = setup();
    const r = buyYes(alice, market, 100);
    const before = alice.trollBalance;
    const exit = sellYes(alice, market, r.quote.shares);
    expect(alice.trollBalance).toBeCloseTo(before + exit.quote.trollAmount, 12);
  });

  it("symmetric round-trip recovers ~100% (no spread in empty market)", () => {
    const { alice, market } = setup();
    const r = buyYes(alice, market, 100);
    const exit = sellYes(alice, market, r.quote.shares);
    expect(exit.quote.trollAmount).toBeCloseTo(100, 6);
  });

  it("position transitions to closed after a full exit", () => {
    const { alice, market } = setup();
    const r = buyYes(alice, market, 100);
    sellYes(alice, market, r.quote.shares);
    const pos = market.positions[0]!;
    expect(pos.status).toBe("closed");
    expect(pos.shares).toBe(0);
    expect(pos.costBasisTroll).toBe(0);
  });

  it("avgEntryPrice is preserved across a partial sell", () => {
    const { alice, market } = setup();
    buyYes(alice, market, 100);
    const pos = market.positions[0]!;
    const entryBefore = pos.averageEntryPriceCents;
    sellYes(alice, market, pos.shares / 3);
    expect(pos.averageEntryPriceCents).toBeCloseTo(entryBefore, 12);
  });

  it("two buys at different prices produce a weighted-average entry", () => {
    const { alice, bob, market } = setup();
    const first = buyYes(alice, market, 100);
    // Bob crashes the YES price...
    buyNo(bob, market, 300);
    const second = buyYes(alice, market, 100);
    const pos = market.positions.find((p) => p.wallet === "alice" && p.side === "YES")!;
    expect(pos.costBasisTroll).toBeCloseTo(200, 12);
    expect(pos.shares).toBeCloseTo(first.quote.shares + second.quote.shares, 12);
    // Alice's avg is between the two trade prices.
    const lo = Math.min(first.quote.avgPriceCents, second.quote.avgPriceCents);
    const hi = Math.max(first.quote.avgPriceCents, second.quote.avgPriceCents);
    expect(pos.averageEntryPriceCents).toBeGreaterThan(lo);
    expect(pos.averageEntryPriceCents).toBeLessThan(hi);
  });
});

describe("trade events", () => {
  it("every buy emits a TradeEvent appended to market.trades", () => {
    const { alice, bob, market } = setup();
    expect(market.trades).toHaveLength(0);
    buyYes(alice, market, 50);
    buyNo(bob, market, 100);
    expect(market.trades).toHaveLength(2);
    expect(market.trades[0]!.action).toBe("buy_yes");
    expect(market.trades[0]!.wallet).toBe("alice");
    expect(market.trades[1]!.action).toBe("buy_no");
    expect(market.trades[1]!.wallet).toBe("bob");
  });

  it("trade event captures price-before, price-after and avg price", () => {
    const { alice, market } = setup();
    const before = market.yesPriceCents;
    buyYes(alice, market, 100);
    const t = market.trades[0]!;
    expect(t.priceBeforeCents).toBeCloseTo(before, 6);
    expect(t.priceAfterCents).toBeCloseTo(market.yesPriceCents, 6);
    expect(t.priceCents).toBeGreaterThan(before);
    expect(t.priceCents).toBeLessThan(t.priceAfterCents);
    expect(t.avgPriceCents).toBeCloseTo(t.priceCents, 6); // first trade ⇒ avg = trade price
  });

  it("sell emits sell_yes / sell_no with amountTroll = proceeds", () => {
    const { alice, market } = setup();
    const r = buyYes(alice, market, 100);
    const exit = sellYes(alice, market, r.quote.shares / 2);
    const sellTrade = market.trades.at(-1)!;
    expect(sellTrade.action).toBe("sell_yes");
    expect(sellTrade.amountTroll).toBeCloseTo(exit.quote.trollAmount, 12);
  });
});

describe("lock-time gating", () => {
  it("user CAN exit before lock", () => {
    const { alice, market } = setup();
    expect(() => buyYes(alice, market, 50)).not.toThrow();
    const pos = market.positions[0]!;
    expect(() => sellYes(alice, market, pos.shares / 2)).not.toThrow();
  });

  it("user CANNOT trade after lock", () => {
    const store = new MemoryStore();
    const alice = store.upsertUser("alice", 1000);
    // closeAt in the past so tick() rolls the market through lock + window.
    const market = store.addMarket(
      createMarket({
        symbol: "TROLL",
        scheduleType: "15m",
        closeAt: new Date(Date.now() - 1_000),
        targetMc: 60_000_000,
      }),
    );
    tick(market, new Date());
    expect(market.status).not.toBe("open");
    expect(() => buyYes(alice, market, 50)).toThrow();
    expect(() => sellYes(alice, market, 1)).toThrow();
  });

  it("lock transitions open positions to status 'locked'", () => {
    const { alice, market } = setup();
    buyYes(alice, market, 100);
    const pos = market.positions[0]!;
    expect(pos.status).toBe("open");
    // v17 product rule: lock fires at closeAt (not lockAt).  Force the
    // clock to closeAt and verify both the market and position flip.
    tick(market, market.closeAt);
    expect(market.status).toBe("locked");
    expect(pos.status).toBe("locked");
  });

  it("v17: market is still tradable past lockAt but before closeAt", () => {
    // Regression guard for the v17 product-rule change.  Markets must NOT
    // lock until closeAt — the "lockAt = closeAt - window/2" buffer that
    // older versions of the brain used to pre-emptively close trading is
    // no longer a behavioral cutoff.  Users keep predicting until close.
    const { alice, market } = setup();
    const between = new Date(
      (market.lockAt.getTime() + market.closeAt.getTime()) / 2,
    );
    expect(between.getTime()).toBeGreaterThan(market.lockAt.getTime());
    expect(between.getTime()).toBeLessThan(market.closeAt.getTime());
    tick(market, between);
    expect(market.status).toBe("open");
    expect(() => buyYes(alice, market, 25)).not.toThrow();
  });
});

describe("position helpers", () => {
  it("calculatePositionValue uses current displayed price", () => {
    const { alice, market } = setup();
    buyYes(alice, market, 100);
    const pos = market.positions[0]!;
    const value = calculatePositionValue(pos, market);
    expect(value).toBeCloseTo(pos.shares * (market.yesPriceCents / 100), 8);
  });

  it("calculateUnrealizedPnL = value - costBasis", () => {
    const { alice, market } = setup();
    buyYes(alice, market, 100);
    const pos = market.positions[0]!;
    const value = calculatePositionValue(pos, market);
    expect(calculateUnrealizedPnL(pos, market)).toBeCloseTo(
      value - pos.costBasisTroll,
      12,
    );
  });
});

describe("scheduler timing", () => {
  it("windowSecondsFor: 30/60/120 for 15m/hourly/daily", () => {
    expect(windowSecondsFor("15m")).toBe(30);
    expect(windowSecondsFor("hourly")).toBe(60);
    expect(windowSecondsFor("daily")).toBe(120);
  });

  it("pollCadenceFor: 5/5/10", () => {
    expect(pollCadenceFor("15m")).toBe(5);
    expect(pollCadenceFor("hourly")).toBe(5);
    expect(pollCadenceFor("daily")).toBe(10);
  });

  it("lockOffsetSecondsFor: 15/30/60 (= window/2)", () => {
    expect(lockOffsetSecondsFor("15m")).toBe(15);
    expect(lockOffsetSecondsFor("hourly")).toBe(30);
    expect(lockOffsetSecondsFor("daily")).toBe(60);
  });

  it("nextQuarterHour rolls forward to the next :00/:15/:30/:45", () => {
    const now = new Date("2026-05-01T12:07:23.000Z");
    const next = nextQuarterHour(now);
    expect(next.toISOString()).toBe("2026-05-01T12:15:00.000Z");
  });

  it("nextQuarterHour rolls hour boundary correctly from :47 → next hour :00", () => {
    const now = new Date("2026-05-01T12:47:00.000Z");
    expect(nextQuarterHour(now).toISOString()).toBe("2026-05-01T13:00:00.000Z");
  });

  it("nextTopOfHour rolls to next top-of-hour", () => {
    const now = new Date("2026-05-01T12:07:23.000Z");
    expect(nextTopOfHour(now).toISOString()).toBe("2026-05-01T13:00:00.000Z");
  });

  it("nextDailyClose returns 19:00 New York during EDT (UTC−4)", () => {
    // August 1 — EDT in effect.
    const now = new Date("2026-08-01T10:00:00.000Z"); // 06:00 NY
    const next = nextDailyClose(now);
    // 19:00 NY in EDT = 23:00 UTC.
    expect(next.toISOString()).toBe("2026-08-01T23:00:00.000Z");
  });

  it("nextDailyClose returns 19:00 New York during EST (UTC−5)", () => {
    // January 15 — EST in effect.
    const now = new Date("2026-01-15T10:00:00.000Z"); // 05:00 NY
    const next = nextDailyClose(now);
    // 19:00 NY in EST = 00:00 UTC next day.
    expect(next.toISOString()).toBe("2026-01-16T00:00:00.000Z");
  });

  it("nextDailyClose rolls to next day if today's close already passed", () => {
    // August 1, 23:30 UTC = August 1 19:30 NY (EDT) — already past 19:00.
    const now = new Date("2026-08-01T23:30:00.000Z");
    const next = nextDailyClose(now);
    // Next 19:00 NY = August 2 23:00 UTC.
    expect(next.toISOString()).toBe("2026-08-02T23:00:00.000Z");
  });

  it("createMarket sets lockAt at closeAt - windowSeconds/2", () => {
    const closeAt = new Date("2026-05-01T12:15:00.000Z");
    const m = createMarket({
      symbol: "TROLL",
      scheduleType: "15m",
      closeAt,
      targetMc: 60_000_000,
    });
    expect(m.lockAt.getTime()).toBe(closeAt.getTime() - 15_000);
    expect(m.windowSeconds).toBe(30);
    expect(m.pollCadenceSeconds).toBe(5);
  });
});
