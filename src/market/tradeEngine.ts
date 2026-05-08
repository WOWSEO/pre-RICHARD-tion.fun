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
  getPricesCents,
  payoutMultiplierForBuy,
  quoteBuy,
} from "./pricingEngine";
import { findOrCreatePosition, sumOpenInterest } from "./positionEngine";

/**
 * v52 — Parimutuel trade engine.
 *
 * Changes from v0–v51 (LMSR era):
 *   - Buys add stake directly into the YES or NO pool, 1:1.
 *   - "Shares" = stake amount (preserved for schema compatibility).
 *   - Sells are blocked.  Once you stake on a parimutuel market, you're
 *     locked until settlement.  This is fundamental to parimutuel — early
 *     exit would change the pool ratios that other participants depend on
 *     for their implied payout multipliers.
 *   - Slippage protection switched from `maxPriceCents` (LMSR concept) to
 *     `minPayoutMultiplier` (parimutuel-native): "only execute if my gross
 *     payout would be at least Nx my stake".
 */

function nextTradeId(): string {
  return `trade_${randomUuidShort()}`;
}

function randomUuidShort(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

// ----- Refresh display fields after a trade -----

function refreshMarketDisplay(market: Market): void {
  const { yes, no } = getPricesCents(market.amm);
  market.yesPriceCents = yes;
  market.noPriceCents = no;
  // In parimutuel, qYes/qNo are pool totals (in TROLL/SOL units, not LMSR
  // share counts).  yesLiquidity/noLiquidity mirror them — frontends that
  // read these fields get a meaningful "pool size" number.
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
  minPayoutMultiplier?: number,
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

  // v52 — slippage protection.  In parimutuel, "slippage" is measured by
  // the implied payout multiplier (gross payout / stake if your side wins).
  // Reject the trade if the multiplier would be below the user's tolerance.
  // Empty market or first-mover-on-side: multiplier ≈ 1.0 (you get your
  // stake back if you win, no upside).  Balanced market: ~2.0.  This is
  // what users actually care about — "if I win, how much do I make?"
  if (minPayoutMultiplier !== undefined) {
    const multiplier = payoutMultiplierForBuy(market, side, trollAmount);
    if (multiplier < minPayoutMultiplier) {
      throw new Error(
        `buy${side}: payout multiplier ${multiplier.toFixed(3)} ` +
          `below minimum ${minPayoutMultiplier.toFixed(3)}`,
      );
    }
  }

  const quote: TradeQuote = quoteBuy(market, side, trollAmount);
  market.amm = applyBuy(market.amm, side, quote.shares);
  user.trollBalance -= trollAmount;

  const position = findOrCreatePosition(market, user, side, now);
  // In parimutuel, every dollar you stake adds to the position the same
  // way regardless of when in the market you bet.  Cost-basis bookkeeping
  // is identical to LMSR for back-compat with audit/tax tooling, but
  // averageEntryPriceCents is just the pool-ratio at execution time —
  // it's a UI artifact, not a payout determinant.
  const newShares = position.shares + quote.shares;
  const newCost = position.costBasisTroll + trollAmount;
  position.shares = newShares;
  position.costBasisTroll = newCost;
  // For parimutuel, weighted-avg "entry price" = the pool ratio at this
  // trade's midpoint, weighted by stake.  Matches user intuition:
  // "I bought when YES was at 47¢".
  const newAvgEntry =
    (position.averageEntryPriceCents * position.shares - quote.avgPriceCents * quote.shares) /
    Math.max(1e-9, newShares - quote.shares);
  // Simpler weighted average over total stake (avoids divide-by-zero on first buy):
  if (newShares > 0) {
    position.averageEntryPriceCents =
      ((position.averageEntryPriceCents * (newShares - quote.shares)) +
        (quote.avgPriceCents * quote.shares)) /
      newShares;
  } else {
    position.averageEntryPriceCents = quote.avgPriceCents;
  }
  // Suppress unused-var warning from intermediate calculation
  void newAvgEntry;
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

// ----- Sell / Exit (v54.4: parimutuel exit-at-cost-basis) -----

/**
 * Parimutuel exit. The user gets their proportional cost basis back and the
 * pool decreases by exactly that amount. Conservation holds: every dollar
 * pulled out of a position also leaves the pool, so other participants'
 * payout multipliers shift but no one is ever underfunded.
 *
 * Math:
 *   stakeToReturn   = (sharesToExit / position.shares) * position.costBasisTroll
 *   pool[side]     -= stakeToReturn
 *   position.shares       -= sharesToExit
 *   position.costBasisTroll -= stakeToReturn
 *
 * The 3% platform fee is NOT charged here. It is applied later by
 * payoutEngine when the withdrawal row is processed (the existing
 * `feeApplies = reason === 'payout' || 'exit'` gate).
 *
 * Edge cases:
 *   - Market not open       -> throw (locked positions cannot exit)
 *   - sharesToExit > shares -> throw (cannot exit more than you hold)
 *   - Full exit (residual < epsilon) -> position.status = 'closed'
 *
 * Side effects on settlement: if exits drain a winning pool to zero, the
 * settlement engine treats the market as VOID so loser stakes don't get
 * orphaned. See settlementEngine.applyPayouts.
 */
function sell(
  user: User,
  market: Market,
  side: Side,
  sharesToExit: number,
  now: Date = new Date(),
): ExecutionReceipt {
  if (market.status !== "open") {
    throw new Error(
      `sell${side}: market ${market.id} is ${market.status}, not open`,
    );
  }
  if (!Number.isFinite(sharesToExit) || sharesToExit <= 0) {
    throw new Error(`sell${side}: sharesToExit must be a positive number`);
  }

  const position = market.positions.find(
    (p) => p.wallet === user.wallet && p.side === side && p.status === "open",
  );
  if (!position) {
    throw new Error(
      `sell${side}: no open ${side} position for wallet ${user.wallet} on market ${market.id}`,
    );
  }
  if (sharesToExit > position.shares + 1e-9) {
    throw new Error(
      `sell${side}: cannot exit ${sharesToExit} shares, position has only ${position.shares}`,
    );
  }

  // Capture market price before the pool changes so the trade event has a
  // meaningful before/after for the audit trail.
  const priceBefore = side === "YES" ? market.yesPriceCents : market.noPriceCents;

  // Proportional cost-basis refund. For a single-buy position where
  // shares == costBasisTroll == stake, this simplifies to just sharesToExit.
  // For aggregated positions across multiple buys, the proportional split
  // returns the right slice of the user's average stake.
  const fraction = sharesToExit / position.shares;
  const stakeToReturn = fraction * position.costBasisTroll;

  // Decrease the pool. Math.max guards against floating-point drift pushing
  // us slightly negative on a full drain.
  if (side === "YES") {
    market.amm.qYes = Math.max(0, market.amm.qYes - stakeToReturn);
  } else {
    market.amm.qNo = Math.max(0, market.amm.qNo - stakeToReturn);
  }

  // Update position. averageEntryPriceCents stays the same for a partial
  // exit (you exit at average cost, so the remaining shares have the same
  // average). On full exit we zero everything and mark closed.
  const newShares = position.shares - sharesToExit;
  const newCostBasis = position.costBasisTroll - stakeToReturn;
  if (newShares < 1e-9) {
    position.shares = 0;
    position.costBasisTroll = 0;
    position.status = "closed";
  } else {
    position.shares = newShares;
    position.costBasisTroll = newCostBasis;
  }
  position.updatedAt = now;

  // Note: do NOT bump market.volume on exits. Volume is a measure of new
  // stake entering the market, not gross turnover.
  refreshMarketDisplay(market);

  const priceAfter = side === "YES" ? market.yesPriceCents : market.noPriceCents;
  const action: TradeAction = side === "YES" ? "sell_yes" : "sell_no";
  const trade: TradeEvent = {
    id: nextTradeId(),
    marketId: market.id,
    wallet: user.wallet,
    action,
    amountTroll: stakeToReturn,
    shares: sharesToExit,
    priceCents: priceBefore,
    avgPriceCents: position.averageEntryPriceCents,
    priceBeforeCents: priceBefore,
    priceAfterCents: priceAfter,
    timestamp: now,
  };
  market.trades.push(trade);

  const quote: TradeQuote = {
    side,
    action: "sell",
    trollAmount: stakeToReturn,
    shares: sharesToExit,
    avgPriceCents: priceBefore,
    marketPriceBeforeCents: priceBefore,
    marketPriceAfterCents: priceAfter,
    priceImpactCents: priceAfter - priceBefore,
  };

  return {
    quote,
    trade,
    positionId: position.id,
    newUserTrollBalance: user.trollBalance + stakeToReturn,
    newPositionShares: position.shares,
    newPositionAverageEntryPriceCents: position.averageEntryPriceCents,
  };
}

// ----- Public spec-shaped API -----

export function buyYes(
  user: User,
  market: Market,
  trollAmount: number,
  now?: Date,
  minPayoutMultiplier?: number,
): ExecutionReceipt {
  return buy(user, market, "YES", trollAmount, now, minPayoutMultiplier);
}
export function buyNo(
  user: User,
  market: Market,
  trollAmount: number,
  now?: Date,
  minPayoutMultiplier?: number,
): ExecutionReceipt {
  return buy(user, market, "NO", trollAmount, now, minPayoutMultiplier);
}
export function sellYes(user: User, market: Market, yesShares: number, now?: Date): ExecutionReceipt {
  return sell(user, market, "YES", yesShares, now);
}
export function sellNo(user: User, market: Market, noShares: number, now?: Date): ExecutionReceipt {
  return sell(user, market, "NO", noShares, now);
}
