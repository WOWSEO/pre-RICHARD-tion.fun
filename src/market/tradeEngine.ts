import type {
  ExecutionReceipt,
  Market,
  Side,
  TradeAction,
  TradeEvent,
  TradeQuote,
  User,
} from "./marketTypes";
import {
  applyBuy,
  applySell,
  getPricesCents,
  quoteBuy,
  quoteSell,
} from "./pricingEngine";
import { findOrCreatePosition, sumOpenInterest } from "./positionEngine";

/**
 * Trade engine. All buy/sell operations:
 *   - check market.status === "open" (lock gating per spec)
 *   - check user has sufficient balance / shares
 *   - mutate market.amm, market.yesPriceCents, market.noPriceCents,
 *     market.yesLiquidity, market.noLiquidity, market.volume, market.openInterest
 *   - mutate the user's position in market.positions (cost-basis math)
 *   - mutate user.trollBalance
 *   - APPEND a TradeEvent to market.trades
 *
 * No external state — Positions and trades live inside their Market. This keeps
 * the public signatures simple: `buyYes(user, market, trollAmount)`.
 */

// AUDIT FIX: trade IDs were `trade_${++sequentialCounter}`, which reset on every
// server boot.  After a restart, `trade_1` would collide with the row already in
// the trades table from the previous boot — primary-key violation, 500 to the user.
// Now we use crypto.randomUUID() so IDs are unique across processes and restarts.
// The `trade_` prefix is retained for legibility in logs and the audit page.
function nextTradeId(): string {
  return `trade_${randomUuidShort()}`;
}

function randomUuidShort(): string {
  // Node 18+ exposes crypto.randomUUID at the global level. We strip the dashes
  // for compactness — the resulting 32-char hex is still 128 bits of entropy.
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

// ----- Refresh display fields after a trade -----

function refreshMarketDisplay(market: Market): void {
  const { yes, no } = getPricesCents(market.amm);
  market.yesPriceCents = yes;
  market.noPriceCents = no;
  market.yesLiquidity = market.amm.qYes;
  market.noLiquidity = market.amm.qNo;
  market.openInterest = sumOpenInterest(market);
}

// ----- Buy -----

function buy(
  user: User,
  market: Market,
  side: Side,
  trollAmount: number,
  now: Date = new Date(),
): ExecutionReceipt {
  if (market.status !== "open") {
    throw new Error(
      `buy${side}: market ${market.id} is ${market.status}, not open`,
    );
  }
  if (trollAmount <= 0) {
    throw new Error(`buy${side}: amount must be positive`);
  }
  if (user.trollBalance < trollAmount - 1e-9) {
    throw new Error(
      `buy${side}: wallet ${user.wallet} balance ${user.trollBalance} < ${trollAmount}`,
    );
  }

  const quote: TradeQuote = quoteBuy(market, side, trollAmount);
  market.amm = applyBuy(market.amm, side, quote.shares);
  user.trollBalance -= trollAmount;

  const position = findOrCreatePosition(market, user, side, now);
  // Weighted-average cost basis update.
  const newShares = position.shares + quote.shares;
  const newCost = position.costBasisTroll + trollAmount;
  position.shares = newShares;
  position.costBasisTroll = newCost;
  position.averageEntryPriceCents = (newCost / newShares) * 100;
  position.updatedAt = now;

  market.volume += trollAmount;
  refreshMarketDisplay(market);

  const action: TradeAction = side === "YES" ? "buy_yes" : "buy_no";
  const trade: TradeEvent = {
    id: nextTradeId(),
    marketId: market.id,
    wallet: user.wallet,
    action,
    amountTroll: trollAmount,
    shares: quote.shares,
    priceCents: quote.avgPriceCents,
    avgPriceCents: position.averageEntryPriceCents,
    priceBeforeCents: quote.marketPriceBeforeCents,
    priceAfterCents: quote.marketPriceAfterCents,
    timestamp: now,
  };
  market.trades.push(trade);

  return {
    quote,
    trade,
    positionId: position.id,
    newUserTrollBalance: user.trollBalance,
    newPositionShares: position.shares,
    newPositionAverageEntryPriceCents: position.averageEntryPriceCents,
  };
}

// ----- Sell / Exit -----

function sell(
  user: User,
  market: Market,
  side: Side,
  shares: number,
  now: Date = new Date(),
): ExecutionReceipt {
  if (market.status !== "open") {
    throw new Error(
      `sell${side}: market ${market.id} is ${market.status}; exits not allowed`,
    );
  }
  if (shares <= 0) {
    throw new Error(`sell${side}: shares must be positive`);
  }

  const position = market.positions.find(
    (p) =>
      p.wallet === user.wallet && p.side === side && p.status === "open",
  );
  if (!position) {
    throw new Error(
      `sell${side}: wallet ${user.wallet} has no open ${side} position in ${market.id}`,
    );
  }
  if (shares > position.shares + 1e-9) {
    throw new Error(
      `sell${side}: wallet ${user.wallet} only holds ${position.shares} ${side} shares`,
    );
  }

  const quote: TradeQuote = quoteSell(market, side, shares);
  market.amm = applySell(market.amm, side, shares);
  user.trollBalance += quote.trollAmount;

  // Realized PnL on the portion sold = proceeds − basisSold.
  // basisSold = sharesSold × averageEntryPrice. avgEntryPrice is preserved on sells.
  const avgEntry = position.averageEntryPriceCents / 100; // back to [0,1]
  const basisSold = shares * avgEntry;
  const realizedDelta = quote.trollAmount - basisSold;
  position.realizedPnlTroll += realizedDelta;
  position.shares -= shares;
  position.costBasisTroll -= basisSold;
  position.updatedAt = now;
  if (position.shares <= 1e-9) {
    position.shares = 0;
    position.costBasisTroll = 0;
    position.status = "closed";
  }

  market.volume += quote.trollAmount;
  refreshMarketDisplay(market);

  const action: TradeAction = side === "YES" ? "sell_yes" : "sell_no";
  const trade: TradeEvent = {
    id: nextTradeId(),
    marketId: market.id,
    wallet: user.wallet,
    action,
    amountTroll: quote.trollAmount,
    shares,
    priceCents: quote.avgPriceCents,
    avgPriceCents: position.averageEntryPriceCents,
    priceBeforeCents: quote.marketPriceBeforeCents,
    priceAfterCents: quote.marketPriceAfterCents,
    timestamp: now,
  };
  market.trades.push(trade);

  return {
    quote,
    trade,
    positionId: position.id,
    newUserTrollBalance: user.trollBalance,
    newPositionShares: position.shares,
    newPositionAverageEntryPriceCents: position.averageEntryPriceCents,
  };
}

// ----- Public spec-shaped API -----

export function buyYes(user: User, market: Market, trollAmount: number, now?: Date): ExecutionReceipt {
  return buy(user, market, "YES", trollAmount, now);
}
export function buyNo(user: User, market: Market, trollAmount: number, now?: Date): ExecutionReceipt {
  return buy(user, market, "NO", trollAmount, now);
}
export function sellYes(user: User, market: Market, yesShares: number, now?: Date): ExecutionReceipt {
  return sell(user, market, "YES", yesShares, now);
}
export function sellNo(user: User, market: Market, noShares: number, now?: Date): ExecutionReceipt {
  return sell(user, market, "NO", noShares, now);
}
