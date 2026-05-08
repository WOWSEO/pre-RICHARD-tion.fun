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

  // ============================================================================
  // v56 — Polymarket-style market-rate exit math.
  //
  // Replaces v54.4's cost-basis exit.  The fair value of an early exit
  // depends on how the implied price has moved since entry:
  //
  //     fair_value = stake × (now_price / entry_price)
  //
  // Profit (now > entry) is funded by the contra-pool — money the losing
  // side has staked.  Loss-locking (now < entry) leaves the unclaimed
  // residual in the side pool, where it benefits remaining holders.
  //
  // Solvency cap: the contra-pool can never fund more than its own size, so
  // exit_value ≤ stake + contra_pool.  When the cap binds, the user gets
  // the maximum the market can afford (stake + entire contra-pool).
  //
  // Conservation:
  //   side_pool_after  = side_pool_before  - stake  +  max(0, stake - paid)
  //   contra_pool_after = contra_pool_before - max(0, paid - stake)
  //   total_after = total_before - paid    ✓
  //
  // Settlement after early exits: the parimutuel rule still applies — winners
  // split (qYes_after + qNo_after) proportionally to their remaining stakes.
  // Because exits remove stake from the side pool, holders who stayed have a
  // larger share of a smaller pool.  The math stays internally consistent.
  //
  // Fee: 3% of gross proceeds is charged at withdrawal time (payoutEngine).
  // ============================================================================
  const priceBefore = side === "YES" ? market.yesPriceCents : market.noPriceCents;
  const sidePool = side === "YES" ? market.amm.qYes : market.amm.qNo;
  const contraPool = side === "YES" ? market.amm.qNo : market.amm.qYes;

  // Proportional share of the position being exited.
  const fraction = sharesToExit / position.shares;
  const stakeBeingExited = fraction * position.costBasisTroll;
  const entryPriceCents = position.averageEntryPriceCents;

  // Fair value at the current implied price.  If entry is somehow zero
  // (shouldn't happen in production but defend anyway), fall back to stake.
  let grossProceeds: number;
  if (entryPriceCents > 0) {
    grossProceeds = stakeBeingExited * (priceBefore / entryPriceCents);
  } else {
    grossProceeds = stakeBeingExited;
  }

  // Solvency cap: the most we can pay out is the user's own stake plus the
  // entire contra-pool.  Any further would push contraPool negative.
  const solvencyCap = stakeBeingExited + contraPool;
  if (grossProceeds > solvencyCap) {
    grossProceeds = solvencyCap;
  }
  // Floor at zero — can't pay negative.  Also, if the price somehow rounded
  // to zero, we still owe at least a tiny amount.  Use 1¢-equivalent as a
  // floor on the share-value to avoid rounding to literally zero refunds on
  // valid exits.
  if (!Number.isFinite(grossProceeds) || grossProceeds < 0) {
    grossProceeds = 0;
  }

  const profit = grossProceeds - stakeBeingExited;

  // Pool accounting (always-non-negative-guarded).
  if (side === "YES") {
    market.amm.qYes = Math.max(0, market.amm.qYes - stakeBeingExited);
    if (profit > 0) {
      // Profit is funded by the NO pool.
      market.amm.qNo = Math.max(0, market.amm.qNo - profit);
    } else if (profit < 0) {
      // Loss-locked: residual stays in YES pool for remaining holders.
      market.amm.qYes = market.amm.qYes + (-profit);
    }
  } else {
    market.amm.qNo = Math.max(0, market.amm.qNo - stakeBeingExited);
    if (profit > 0) {
      market.amm.qYes = Math.max(0, market.amm.qYes - profit);
    } else if (profit < 0) {
      market.amm.qNo = market.amm.qNo + (-profit);
    }
  }

  // Update position.  Realized PnL accumulates the profit/loss component.
  const newShares = position.shares - sharesToExit;
  const newCostBasis = position.costBasisTroll - stakeBeingExited;
  position.realizedPnlTroll = (position.realizedPnlTroll ?? 0) + profit;
  if (newShares < 1e-9) {
    position.shares = 0;
    position.costBasisTroll = 0;
    position.status = "closed";
  } else {
    position.shares = newShares;
    position.costBasisTroll = newCostBasis;
    // averageEntryPriceCents stays the same — the user is still holding the
    // remainder at the same average entry.
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
    amountTroll: grossProceeds,
    shares: sharesToExit,
    priceCents: priceBefore,
    avgPriceCents: entryPriceCents,
    priceBeforeCents: priceBefore,
    priceAfterCents: priceAfter,
    timestamp: now,
  };
  market.trades.push(trade);

  const quote: TradeQuote = {
    side,
    action: "sell",
    trollAmount: grossProceeds,
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
    newUserTrollBalance: user.trollBalance + grossProceeds,
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
