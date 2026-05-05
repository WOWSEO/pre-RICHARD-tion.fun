/**
 * Public entry point. Re-exports the brain's API surface so consumers can:
 *
 *   import { createMarket, buyYes, settleMarket, MockProvider } from "pumparena-brain";
 */

export { TROLL } from "./config/troll";

// Types
export type {
  Side,
  ScheduleType,
  MarketStatus,
  Outcome,
  TradeAction,
  CoinConfig,
  AmmState,
  Market,
  Position,
  User,
  TradeEvent,
  TradeQuote,
  ExecutionReceipt,
  Snapshot,
  SourceName,
  ResolverInput,
  ResolverOutput,
  UserSettlement,
  AuditReceipt,
} from "./market/marketTypes";

// Pricing
export {
  DEFAULT_B,
  MIN_PRICE,
  MAX_PRICE,
  newAmmState,
  getPrices,
  getPricesCents,
  getRawPrices,
  cost,
  costToTrade,
  sharesForBuy,
  proceedsForSell,
  applyBuy,
  applySell,
  quoteBuyYes,
  quoteBuyNo,
  quoteSellYes,
  quoteSellNo,
  calculatePriceImpact,
} from "./market/pricingEngine";

// Trading
export { buyYes, buyNo, sellYes, sellNo } from "./market/tradeEngine";

// Positions
export {
  calculatePositionValue,
  calculateRealizedPnL,
  calculateUnrealizedPnL,
  findOpenPosition,
  listUserPositions,
} from "./market/positionEngine";

// Scheduler / lifecycle
export {
  createMarket,
  windowSecondsFor,
  pollCadenceFor,
  lockOffsetSecondsFor,
  nextQuarterHour,
  nextTopOfHour,
  nextDailyClose,
  tick,
  isTradingAllowed,
  closeWindow,
} from "./market/scheduler";

// Settlement
export {
  resolve,
  applyPayouts,
  collectSnapshotsSynthetic,
  collectSnapshotsLive,
  settleMarket,
} from "./market/settlementEngine";

// Audit
export {
  buildAuditReceipt,
  printAuditReceipt,
} from "./market/auditReceipt";

// Providers
export type { MarketCapProvider } from "./providers/providerTypes";
export { MockProvider } from "./providers/mockProvider";
export { DexScreenerProvider } from "./providers/dexScreenerProvider";
export { GeckoTerminalProvider } from "./providers/geckoTerminalProvider";
export { HeliusProvider } from "./providers/heliusProvider";

// Store
export { MemoryStore } from "./store/memoryStore";
