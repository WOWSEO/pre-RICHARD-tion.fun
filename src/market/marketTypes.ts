// Core market type definitions.
// Prediction-market language only: YES / NO, Over / Under, MC, position, exit, settlement, audit.
// Simulation only — no real money, no token transfer, no escrow. 18+.

export type Side = "YES" | "NO";

export type ScheduleType = "15m" | "hourly" | "daily";

export type MarketStatus =
  | "open"      // accepting buys/sells
  | "locked"    // settlement window has begun, no trading
  | "settling"  // window closed, computing canonical MC
  | "settled"   // outcome decided, payouts done
  | "voided";   // settlement determined the market voids

export type Outcome = "YES" | "NO" | "VOID";

export type TradeAction = "buy_yes" | "buy_no" | "sell_yes" | "sell_no";

export interface CoinConfig {
  symbol: string;
  name: string;
  mintAddress: string;
  decimals: number;
  pumpfunUrl: string;
  dexscreenerSource: string;
  geckoterminalSource: string;
  heliusSource: string;
  active: boolean;
  /** Liquidity floor in USD. Below this at settlement, the market voids. */
  minLiquidityUsd: number;
  /** 24h volume floor in USD. Same idea. */
  minVolume24hUsd: number;
  /**
   * v54.5 — optional per-coin threshold for VOID(source_disagreement).
   *
   * If unset, the resolver uses the global default (0.025 = 2.5%).  Tighter
   * values are stricter; looser values let lower-liquidity coins settle.
   *
   * Values used in production:
   *   TROLL ($2.5M liquidity)  → omit (uses 2.5% default)
   *   USDUC ($908K liquidity)  → 0.05  (5%)
   *   BUTT  ($13K  liquidity)  → 0.15  (15%)
   *
   * Below this threshold, the resolver accepts the median of medians as
   * canonical_mc.  Above it, the market voids with `source_disagreement`.
   */
  sourceDisagreementThreshold?: number;
}

/**
 * LMSR (Logarithmic Market Scoring Rule) state.
 *
 *   C(qY, qN)         = b * ln(exp(qY/b) + exp(qN/b))
 *   p_YES(qY, qN)     = exp(qY/b) / (exp(qY/b) + exp(qN/b))   ∈ (0, 1)
 *   p_NO              = 1 - p_YES
 *   cost to buy delta = C(qY+delta, qN) - C(qY, qN)
 *
 * - p_YES + p_NO = 1.0 always.
 * - Initial qY = qN = 0  ⇒  p_YES = p_NO = 0.5.
 * - Buying YES shares increases qY, raises p_YES, lowers p_NO.
 * - Higher b ⇒ deeper liquidity ⇒ smaller price impact per share.
 *
 * The DISPLAYED price (yesPriceCents / noPriceCents) is clamped to [1, 99] cents
 * per spec. The underlying AMM math is exact; clamping happens at the display
 * boundary in pricingEngine.getPrices().
 */
export interface AmmState {
  qYes: number;
  qNo: number;
  b: number;
}

/** A user's open trade event — recorded once per buy/sell into market.trades. */
export interface TradeEvent {
  id: string;
  marketId: string;
  wallet: string;
  action: TradeAction;
  /** TROLL paid (buy) or received (sell). Always positive. */
  amountTroll: number;
  /** Shares received (buy) or sold (sell). Always positive. */
  shares: number;
  /** Effective average price of THIS trade, in cents (1..99). */
  priceCents: number;
  /** User's avg entry price for this side AFTER the trade, in cents. */
  avgPriceCents: number;
  /** Market price for this side BEFORE the trade, in cents. */
  priceBeforeCents: number;
  /** Market price for this side AFTER the trade, in cents (clamped to [1, 99]). */
  priceAfterCents: number;
  timestamp: Date;
}

export interface Position {
  id: string;
  wallet: string;
  marketId: string;
  side: Side;
  /** Outstanding shares the user holds. Decreases on exit/sell. */
  shares: number;
  /** Weighted average entry price in cents [1, 99] over the shares still held. */
  averageEntryPriceCents: number;
  /** Cost basis in simulated TROLL of the shares the user CURRENTLY holds. */
  costBasisTroll: number;
  /** Cumulative realized PnL across this position (sells + settlement). */
  realizedPnlTroll: number;
  status: "open" | "closed" | "locked" | "settled" | "void_refunded";
  createdAt: Date;
  updatedAt: Date;
}

export interface Market {
  id: string;
  symbol: string;            // "TROLL"
  question: string;
  /** Target market cap in USD. e.g. 60_000_000 for "Will TROLL be over $60M MC?" */
  targetMc: number;
  closeAt: Date;
  /** When trading stops. closeAt - windowSeconds/2. */
  lockAt: Date;
  windowSeconds: number;       // 30 (15m) | 60 (hourly) | 120 (daily)
  pollCadenceSeconds: number;  // 5 | 5 | 10
  scheduleType: ScheduleType;
  status: MarketStatus;
  amm: AmmState;
  /** YES price in cents, clamped to [1, 99]. Refreshed after every trade. */
  yesPriceCents: number;
  noPriceCents: number;
  /** Outstanding YES shares (= amm.qYes). */
  yesLiquidity: number;
  noLiquidity: number;
  /** Cumulative |notional| of trades in simulated TROLL. */
  volume: number;
  /** Sum of costBasisTroll across all open positions in this market. */
  openInterest: number;
  /** Set when settled or voided. */
  settlementMc: number | null;
  outcome: Outcome | null;
  voidReason: string | null;
  /** Embedded book — positions and trade history live with their market. */
  positions: Position[];
  trades: TradeEvent[];
  createdAt: Date;
  closedAt: Date | null;
}

export interface User {
  /** Solana wallet pubkey, or a placeholder identifier in simulation. */
  wallet: string;
  /** Simulated TROLL credit balance. Replace with real on-chain escrow later. */
  trollBalance: number;
}

// ----- Snapshots / settlement IO -----

export type SourceName = "dexscreener" | "geckoterminal" | "helius_curve" | "mock";

export interface Snapshot {
  source: SourceName;
  fetchedAt: Date;
  /** USD market cap (FDV-based). Null on error. */
  marketCapUsd: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  ok: boolean;
  errorText: string | null;
  rawPayload: unknown;
}

export interface ResolverInput {
  market: Market;
  snapshots: Snapshot[];
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  /** Default 0.025 = 2.5%. */
  sourceDisagreementThreshold: number;
  /** Default 0.001 = 0.1%. */
  deadZoneThreshold: number;
  /** Default 4. */
  minSnapshotsPerSource: number;
}

export interface ResolverOutput {
  outcome: Outcome;
  voidReason: string | null;
  canonicalMc: number | null;
  perSourceMedian: Record<string, number | null>;
  validSnapshotsBySource: Record<string, number>;
}

export interface UserSettlement {
  wallet: string;
  positionId: string;
  side: Side;
  shares: number;
  averageEntryPriceCents: number;
  costBasisTroll: number;
  /** Simulated TROLL credited back to the user's balance. */
  payoutTroll: number;
  /** PnL realized at settlement = payout - cost basis. */
  realizedPnlOnSettlement: number;
  finalStatus: "settled" | "void_refunded";
}

export interface AuditReceipt {
  marketId: string;
  question: string;
  targetMc: number;
  closeAt: string;
  scheduleType: ScheduleType;
  perSourceMedian: Record<string, number | null>;
  canonicalMc: number | null;
  outcome: Outcome;
  voidReason: string | null;
  finalYesPriceCents: number;
  finalNoPriceCents: number;
  snapshots: Snapshot[];
  /** sha256 of the JSON-encoded snapshots array. */
  snapshotBundleHash: string;
  userSettlements: UserSettlement[];
  generatedAt: string;
}

// ----- Quote / execution -----

export interface TradeQuote {
  side: Side;
  action: "buy" | "sell";
  /** TROLL the user pays (buy) or receives (sell). */
  trollAmount: number;
  /** Shares the user receives (buy) or gives up (sell). */
  shares: number;
  /** Effective average price of this trade in cents (1..99). */
  avgPriceCents: number;
  /** Market price for this side BEFORE the trade in cents. */
  marketPriceBeforeCents: number;
  /** Market price for this side AFTER the trade in cents (displayed-clamped). */
  marketPriceAfterCents: number;
  /** Signed price impact in cents: priceAfter - priceBefore (positive on buy, negative on sell). */
  priceImpactCents: number;
}

export interface ExecutionReceipt {
  quote: TradeQuote;
  trade: TradeEvent;
  positionId: string;
  newUserTrollBalance: number;
  newPositionShares: number;
  newPositionAverageEntryPriceCents: number;
}
