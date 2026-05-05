import type { AmmState, Market, Side, TradeQuote } from "./marketTypes";

/**
 * Pricing engine for binary YES/NO markets, LMSR-based.
 *
 *   C(qY, qN)         = b * ln(exp(qY/b) + exp(qN/b))
 *   p_YES_raw         = exp(qY/b) / (exp(qY/b) + exp(qN/b))   ∈ (0, 1)
 *
 * Why LMSR (vs. constant-product):
 *   - Prices ALWAYS sum to exactly 1.0 by construction; no approximation drift.
 *   - Closed-form inverse for "shares for cost" — no numerical solver.
 *   - Bounded loss for the AMM, parameterized by `b`.
 *
 * Display clamp:
 *   Spec requires displayed prices to stay in [1¢, 99¢]. The underlying AMM math
 *   is exact and unclamped; the clamp is applied symmetrically when converting
 *   the raw probability to displayed cents in `getPrices()`. Because the clamp is
 *   symmetric around 0.5, the displayed YES + NO still equals exactly 100¢.
 *
 * Numerical stability:
 *   We use the log-sum-exp trick (subtract max(qY/b, qN/b) before exponentiating)
 *   so cost/getPrices stay finite even for extreme imbalance.
 *
 * Default b: 1000. With b = 1000, a 100-TROLL YES buy from neutral state moves
 * the YES price from 50.00¢ to ~54.76¢ — perceptible without snapping the book.
 */

export const DEFAULT_B = 1000;
export const MIN_PRICE = 0.01; // 1¢
export const MAX_PRICE = 0.99; // 99¢

export function newAmmState(b: number = DEFAULT_B): AmmState {
  return { qYes: 0, qNo: 0, b };
}

/** LMSR cost function, numerically stable via log-sum-exp. */
export function cost(state: AmmState): number {
  const { qYes, qNo, b } = state;
  const a = qYes / b;
  const c = qNo / b;
  const m = Math.max(a, c);
  return b * (m + Math.log(Math.exp(a - m) + Math.exp(c - m)));
}

/** Raw LMSR prices in [0, 1], unclamped. Internal use. */
export function getRawPrices(state: AmmState): { yes: number; no: number } {
  const { qYes, qNo, b } = state;
  const a = qYes / b;
  const c = qNo / b;
  const m = Math.max(a, c);
  const ea = Math.exp(a - m);
  const ec = Math.exp(c - m);
  const sum = ea + ec;
  return { yes: ea / sum, no: ec / sum };
}

/**
 * Display prices: clamped to [MIN_PRICE, MAX_PRICE], still in [0, 1]. Per spec,
 * prices never go below 1¢ or above 99¢. The clamp is symmetric around 0.5,
 * so YES + NO = 1.0 in the clamped output too.
 */
export function getPrices(state: AmmState): { yes: number; no: number } {
  const raw = getRawPrices(state);
  return {
    yes: clamp(raw.yes, MIN_PRICE, MAX_PRICE),
    no: clamp(raw.no, MIN_PRICE, MAX_PRICE),
  };
}

/** Convenience: return YES/NO prices in cents (1..99 floats). */
export function getPricesCents(state: AmmState): { yes: number; no: number } {
  const p = getPrices(state);
  return { yes: p.yes * 100, no: p.no * 100 };
}

/**
 * Cost to push qYes (or qNo) by `delta`. Positive delta = buy. Negative = sell.
 * Uses the EXACT (unclamped) LMSR cost — clamping is for display only.
 */
export function costToTrade(
  state: AmmState,
  side: Side,
  delta: number,
): number {
  const before = cost(state);
  const after =
    side === "YES"
      ? cost({ ...state, qYes: state.qYes + delta })
      : cost({ ...state, qNo: state.qNo + delta });
  return after - before;
}

/**
 * Closed-form inverse: given a TROLL amount the user wants to spend, return the
 * number of shares of `side` they buy. Derivation (YES side, NO is symmetric):
 *
 *   trollAmount/b = ln((exp(a + delta/b) + exp(c)) / (exp(a) + exp(c)))
 *   r             = exp(trollAmount/b)
 *   delta         = b * (ln(r * (e^a + e^c) - e^c) - a)
 *
 * Computed in the m-shifted domain to avoid overflow.
 */
export function sharesForBuy(
  state: AmmState,
  side: Side,
  trollAmount: number,
): number {
  if (trollAmount <= 0) return 0;
  const { qYes, qNo, b } = state;
  const a = qYes / b;
  const c = qNo / b;
  const m = Math.max(a, c);
  const eaShift = Math.exp(a - m);
  const ecShift = Math.exp(c - m);
  const sumShift = eaShift + ecShift;
  const r = Math.exp(trollAmount / b);

  if (side === "YES") {
    const inner = r * sumShift - ecShift;
    if (inner <= 0) throw new Error("sharesForBuy: numerical error");
    return b * (Math.log(inner) - (a - m));
  } else {
    const inner = r * sumShift - eaShift;
    if (inner <= 0) throw new Error("sharesForBuy: numerical error");
    return b * (Math.log(inner) - (c - m));
  }
}

/**
 * Proceeds (positive number, in TROLL) the user receives for selling
 * `shares` of `side`. Caller must ensure the user actually holds those shares.
 */
export function proceedsForSell(
  state: AmmState,
  side: Side,
  shares: number,
): number {
  if (shares <= 0) return 0;
  return -costToTrade(state, side, -shares);
}

/** Apply a buy: returns new AMM state with `shares` more `side` outstanding. */
export function applyBuy(state: AmmState, side: Side, shares: number): AmmState {
  if (side === "YES") return { ...state, qYes: state.qYes + shares };
  return { ...state, qNo: state.qNo + shares };
}

/** Apply a sell: returns new AMM state with `shares` fewer `side` outstanding. */
export function applySell(state: AmmState, side: Side, shares: number): AmmState {
  if (side === "YES") {
    if (shares > state.qYes + 1e-9) {
      throw new Error(
        `applySell: cannot remove ${shares} YES shares; only ${state.qYes} outstanding`,
      );
    }
    return { ...state, qYes: Math.max(0, state.qYes - shares) };
  }
  if (shares > state.qNo + 1e-9) {
    throw new Error(
      `applySell: cannot remove ${shares} NO shares; only ${state.qNo} outstanding`,
    );
  }
  return { ...state, qNo: Math.max(0, state.qNo - shares) };
}

// ----- Quote functions (pure, non-mutating) -----

export function quoteBuy(market: Market, side: Side, trollAmount: number): TradeQuote {
  if (trollAmount <= 0) throw new Error("quoteBuy: amount must be positive");
  const before = getPrices(market.amm);
  const priceBefore = side === "YES" ? before.yes : before.no;
  const shares = sharesForBuy(market.amm, side, trollAmount);
  const next = applyBuy(market.amm, side, shares);
  const after = getPrices(next);
  const priceAfter = side === "YES" ? after.yes : after.no;
  const avgPrice = trollAmount / shares;
  return {
    side,
    action: "buy",
    trollAmount,
    shares,
    avgPriceCents: avgPrice * 100,
    marketPriceBeforeCents: priceBefore * 100,
    marketPriceAfterCents: priceAfter * 100,
    priceImpactCents: (priceAfter - priceBefore) * 100,
  };
}

export function quoteSell(market: Market, side: Side, shares: number): TradeQuote {
  if (shares <= 0) throw new Error("quoteSell: shares must be positive");
  const before = getPrices(market.amm);
  const priceBefore = side === "YES" ? before.yes : before.no;
  const proceeds = proceedsForSell(market.amm, side, shares);
  const next = applySell(market.amm, side, shares);
  const after = getPrices(next);
  const priceAfter = side === "YES" ? after.yes : after.no;
  const avgPrice = proceeds / shares;
  return {
    side,
    action: "sell",
    trollAmount: proceeds,
    shares,
    avgPriceCents: avgPrice * 100,
    marketPriceBeforeCents: priceBefore * 100,
    marketPriceAfterCents: priceAfter * 100,
    priceImpactCents: (priceAfter - priceBefore) * 100, // negative on a sell
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

/** Magnitude of price impact, in cents. Always non-negative. */
export function calculatePriceImpact(quote: TradeQuote): number {
  return Math.abs(quote.priceImpactCents);
}

// ----- helpers -----

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
