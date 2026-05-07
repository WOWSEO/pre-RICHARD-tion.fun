import type { AmmState, Market, Side, TradeQuote } from "./marketTypes";

/**
 * v52 — Parimutuel pricing engine.  Replaces the LMSR AMM.
 *
 * ## Why we switched
 *
 * The v0–v51 system used an LMSR (Logarithmic Market Scoring Rule) AMM with
 * `b=1000` and no external liquidity provider.  In any 1v1 balanced market,
 * the second mover ends up holding more share-count than the total pool
 * can fund — the AMM has a "bounded loss" that a real LMSR expects an LP
 * to subsidize.  Without an LP, the system was structurally insolvent on
 * most 1v1 markets (alice $200 YES + bob $200 NO → if NO wins, bob owed
 * 432 shares × $1 from a $400 pool → 8% short).
 *
 * Parimutuel pools sidestep this entirely:
 *
 *   yesPool = sum of all YES stakes
 *   noPool  = sum of all NO  stakes
 *   pool    = yesPool + noPool
 *
 *   yesProb (display) = yesPool / pool         (50/50 if pool empty)
 *   noProb  (display) = noPool  / pool
 *
 *   Settlement (YES wins):
 *     for each YES position with stake S:
 *       grossPayout = S * (pool / yesPool)
 *                   = S + S * (noPool / yesPool)         [stake + share of loser pool]
 *       netPayout   = grossPayout * (1 - feeRate)        [3% fee on winners only]
 *
 *   Settlement (NO wins): symmetric.
 *   Settlement (VOID): every position refunded their stake (no fee).
 *
 * ## Schema reuse
 *
 * The DB already has `amm_q_yes`, `amm_q_no`, `amm_b` columns on `markets`,
 * and the wire `AmmState` interface on `Market.amm`.  We REPURPOSE these
 * for parimutuel — no migration needed:
 *
 *   amm.qYes = yesPool (sum of YES stakes)
 *   amm.qNo  = noPool  (sum of NO  stakes)
 *   amm.b    = 0       (sentinel — was LMSR liquidity param, now unused)
 *
 * ## Position schema reuse
 *
 *   position.shares             = stake amount (1:1 with cost basis)
 *   position.costBasisTroll     = stake amount (same)
 *   position.averageEntryPriceCents = displayed pool ratio at time of buy,
 *                                     for UI only — does NOT affect payout
 *
 * In parimutuel there's no "share count" distinct from stake — payouts are
 * proportional to stake share of the winning pool.
 *
 * ## Display clamping
 *
 * Displayed prices stay in [1¢, 99¢] (no probability ever shown as 0 or 100,
 * because that implies certainty).  When one pool has 0 stakes, the display
 * would be 100/0 which we clamp to 99/1.  Once both sides have stakes, real
 * ratios apply within [1, 99].
 */

export const MIN_PRICE = 0.01; // 1¢ display floor
export const MAX_PRICE = 0.99; // 99¢ display ceiling

/**
 * `b` is kept in the type for back-compat with the LMSR-era `AmmState`
 * shape but is unused in parimutuel — set to 0 as a sentinel meaning
 * "this market is parimutuel, not LMSR".
 */
export const PARIMUTUEL_SENTINEL_B = 0;
export const DEFAULT_B = PARIMUTUEL_SENTINEL_B; // back-compat alias

export function newAmmState(_b: number = PARIMUTUEL_SENTINEL_B): AmmState {
  return { qYes: 0, qNo: 0, b: PARIMUTUEL_SENTINEL_B };
}

/**
 * Raw probabilities in [0, 1], unclamped.  When the pool is empty on both
 * sides, returns 50/50 (no information yet).
 */
export function getRawPrices(state: AmmState): { yes: number; no: number } {
  const yesPool = Math.max(0, state.qYes);
  const noPool = Math.max(0, state.qNo);
  const total = yesPool + noPool;
  if (total <= 0) return { yes: 0.5, no: 0.5 };
  return { yes: yesPool / total, no: noPool / total };
}

/**
 * Display prices: clamped to [MIN_PRICE, MAX_PRICE].  Sums to exactly 1.0
 * before AND after clamping (because the clamp is symmetric around 0.5).
 */
export function getPrices(state: AmmState): { yes: number; no: number } {
  const raw = getRawPrices(state);
  return {
    yes: clamp(raw.yes, MIN_PRICE, MAX_PRICE),
    no: clamp(raw.no, MIN_PRICE, MAX_PRICE),
  };
}

/** Convenience: prices in cents (1..99 floats). */
export function getPricesCents(state: AmmState): { yes: number; no: number } {
  const p = getPrices(state);
  return { yes: p.yes * 100, no: p.no * 100 };
}

/**
 * Cost-to-trade in parimutuel is just... the stake.  Buying $X of YES
 * costs $X.  Period.  Kept for back-compat.
 */
export function costToTrade(
  _state: AmmState,
  _side: Side,
  delta: number,
): number {
  return Math.max(0, delta);
}

/**
 * Back-compat shim for the LMSR `cost(state)` function.  In LMSR this was
 * the C(qY, qN) total cost function — meaningful for cost-to-trade math.
 * In parimutuel it has no semantic equivalent; we return the total pool
 * size, which is the closest thing to "current cost commitment" of the
 * market.  Existing callers (UI, audit) use this for display only.
 */
export function cost(state: AmmState): number {
  return Math.max(0, state.qYes) + Math.max(0, state.qNo);
}

/**
 * "Shares" in parimutuel = stake amount.  1:1.  No closed-form needed.
 */
export function sharesForBuy(
  _state: AmmState,
  _side: Side,
  trollAmount: number,
): number {
  if (trollAmount <= 0) return 0;
  return trollAmount;
}

/**
 * Selling N shares returns N (1:1).  Sells are blocked by the trade engine
 * in parimutuel — preserved for back-compat with old fixtures only.
 */
export function proceedsForSell(
  _state: AmmState,
  _side: Side,
  shares: number,
): number {
  if (shares <= 0) return 0;
  return shares;
}

/** Add a stake to the appropriate pool. */
export function applyBuy(state: AmmState, side: Side, shares: number): AmmState {
  if (side === "YES") return { ...state, qYes: state.qYes + shares };
  return { ...state, qNo: state.qNo + shares };
}

/** Sell — back-compat only.  Trade engine prevents this in parimutuel. */
export function applySell(state: AmmState, side: Side, shares: number): AmmState {
  if (side === "YES") {
    if (shares > state.qYes + 1e-9) {
      throw new Error(
        `applySell: cannot remove ${shares} from YES pool of ${state.qYes}`,
      );
    }
    return { ...state, qYes: Math.max(0, state.qYes - shares) };
  }
  if (shares > state.qNo + 1e-9) {
    throw new Error(
      `applySell: cannot remove ${shares} from NO pool of ${state.qNo}`,
    );
  }
  return { ...state, qNo: Math.max(0, state.qNo - shares) };
}

// ----- Quote functions (pure, non-mutating) -----

/**
 * Quote for a buy.  In parimutuel:
 *   - You pay exactly `trollAmount`.
 *   - You get `trollAmount` worth of stake on `side` (1:1).
 *   - Displayed "price" is the pool ratio for that side, which the trade
 *     shifts toward your side (more YES money → higher displayed YES prob).
 */
export function quoteBuy(market: Market, side: Side, trollAmount: number): TradeQuote {
  if (trollAmount <= 0) {
    throw new Error(`quoteBuy: amount must be positive (got ${trollAmount})`);
  }
  const beforePrices = getPricesCents(market.amm);
  const afterState = applyBuy(market.amm, side, trollAmount);
  const afterPrices = getPricesCents(afterState);
  const sideBefore = side === "YES" ? beforePrices.yes : beforePrices.no;
  const sideAfter = side === "YES" ? afterPrices.yes : afterPrices.no;
  // Effective average for this trade — midpoint of before/after for the
  // side bought.  Cosmetic only; payout is governed by final pool ratio.
  const avgPriceCents = clamp(
    (sideBefore + sideAfter) / 2,
    MIN_PRICE * 100,
    MAX_PRICE * 100,
  );
  return {
    side,
    action: "buy",
    trollAmount,
    shares: trollAmount, // 1:1 — your stake IS your "shares"
    avgPriceCents,
    marketPriceBeforeCents: sideBefore,
    marketPriceAfterCents: sideAfter,
    priceImpactCents: sideAfter - sideBefore,
  };
}

/** Sell quote — back-compat. */
export function quoteSell(market: Market, side: Side, shares: number): TradeQuote {
  const beforePrices = getPricesCents(market.amm);
  const afterState = applySell(market.amm, side, shares);
  const afterPrices = getPricesCents(afterState);
  const sideBefore = side === "YES" ? beforePrices.yes : beforePrices.no;
  const sideAfter = side === "YES" ? afterPrices.yes : afterPrices.no;
  const avgPriceCents = clamp(
    (sideBefore + sideAfter) / 2,
    MIN_PRICE * 100,
    MAX_PRICE * 100,
  );
  return {
    side,
    action: "sell",
    trollAmount: shares, // 1:1 refund of stake
    shares,
    avgPriceCents,
    marketPriceBeforeCents: sideBefore,
    marketPriceAfterCents: sideAfter,
    priceImpactCents: sideAfter - sideBefore,
  };
}

export function quoteBuyYes(market: Market, trollAmount: number): TradeQuote {
  return quoteBuy(market, "YES", trollAmount);
}
export function quoteBuyNo(market: Market, trollAmount: number): TradeQuote {
  return quoteBuy(market, "NO", trollAmount);
}
export function quoteSellYes(market: Market, yesShares: number): TradeQuote {
  return quoteSell(market, "YES", yesShares);
}
export function quoteSellNo(market: Market, noShares: number): TradeQuote {
  return quoteSell(market, "NO", noShares);
}

export function calculatePriceImpact(quote: TradeQuote): number {
  const before = quote.marketPriceBeforeCents / 100;
  const after = quote.marketPriceAfterCents / 100;
  if (before <= 0) return 0;
  return Math.abs(after - before) / before;
}

/**
 * Implied gross payout multiplier for a buy of `trollAmount` on `side`,
 * AFTER the buy is applied (i.e., your stake counts toward the side pool).
 *
 * Returns: pool_total_after / side_pool_after = grossPayout / stake.
 *
 * Empty market: trade pushes pool to all-on-one-side → multiplier = 1.0
 * (you'd be the only one on that side, so winning means pool/yes = 1).
 *
 * Even-pools market with $X on each side, you bet $1 YES:
 *   yesPool = X+1, noPool = X, total = 2X+1
 *   multiplier = (2X+1) / (X+1) → ~2.0 as X grows
 *
 * Used by tradeEngine to enforce `minPayoutMultiplier` slippage rails.
 * NOTE: this is GROSS — net = multiplier × (1 - feeRate).
 */
export function payoutMultiplierForBuy(
  market: Market,
  side: Side,
  trollAmount: number,
): number {
  const after = applyBuy(market.amm, side, trollAmount);
  const pool = after.qYes + after.qNo;
  const sidePool = side === "YES" ? after.qYes : after.qNo;
  if (sidePool <= 0) return 0;
  return pool / sidePool;
}

// ----- Helpers -----

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
