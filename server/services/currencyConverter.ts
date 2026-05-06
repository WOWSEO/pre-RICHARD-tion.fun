import { fetchTrollSnapshot } from "./marketSnapshot";
import { fetchSolPriceUsd } from "./solPriceFeed";

export type Currency = "troll" | "sol";

export interface ConvertedAmount {
  /** What the user actually deposits (or wants to bet). */
  amountInput: number;
  inputCurrency: Currency;
  /** Canonical SOL-equivalent for ledger/AMM purposes. */
  amountSolEquiv: number;
  /** TROLL/USD at conversion time (snapshot of /api/markets price feed). */
  trollPriceUsd: number;
  /** SOL/USD at conversion time (Jupiter). */
  solPriceUsd: number;
}

/**
 * Convert a user's bet amount (in either TROLL or SOL) to the canonical
 * SOL-equivalent value used by the AMM and settlement engine.
 *
 *   solEquivalent = trollAmount * trollPriceUsd / solPriceUsd
 *   (or amountInput when inputCurrency='sol')
 *
 * All quotes and entry routes pass through this so the brain only ever
 * sees one unit type — no per-currency code paths in tradeEngine.
 *
 * Throws on price-feed failure.  Callers (quote / enter) should surface
 * the verbatim error string so the operator can see whether DexScreener
 * or Jupiter is the unavailable side.
 */
export async function convertToSolEquivalent(
  amountInput: number,
  inputCurrency: Currency,
): Promise<ConvertedAmount> {
  if (!Number.isFinite(amountInput) || amountInput <= 0) {
    throw new Error("invalid_amount");
  }

  // Always grab BOTH prices — even SOL bets store the snapshot for audit.
  const [trollSnap, solPrice] = await Promise.all([
    fetchTrollSnapshot().catch((e) => {
      throw new Error(`troll_price_unavailable: ${(e as Error).message}`);
    }),
    fetchSolPriceUsd().catch((e) => {
      throw new Error(`sol_price_unavailable: ${(e as Error).message}`);
    }),
  ]);

  const trollPriceUsd = trollSnap.priceUsd;
  const solPriceUsd = solPrice.priceUsd;

  if (!(trollPriceUsd > 0) || !(solPriceUsd > 0)) {
    throw new Error("invalid_price_feed_values");
  }

  let amountSolEquiv: number;
  if (inputCurrency === "sol") {
    amountSolEquiv = amountInput;
  } else {
    amountSolEquiv = (amountInput * trollPriceUsd) / solPriceUsd;
  }

  return {
    amountInput,
    inputCurrency,
    amountSolEquiv,
    trollPriceUsd,
    solPriceUsd,
  };
}
