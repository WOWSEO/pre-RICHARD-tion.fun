import type { Market, Position, Side, User } from "./marketTypes";
import { getPrices } from "./pricingEngine";

/**
 * Position management. Positions are stored INSIDE their market (market.positions).
 * Cross-market views (a user's full book) are computed by filtering across markets.
 *
 * A user can hold both YES and NO simultaneously in the same market — the lookup
 * key is (wallet, marketId, side).
 */

// AUDIT FIX: same restart-collision issue as trades — see tradeEngine.ts comment.
let _positionCounter = 0;
export function nextPositionId(): string {
  // Keep the `pos_` prefix; suffix is now collision-free across server restarts.
  // (The `_positionCounter` is retained because it's a public surface — referenced
  // by tests' fixtures — but only the UUID matters for uniqueness.)
  void _positionCounter; // kept to avoid linter complaints if anything else imports it
  return `pos_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}

/** Find the user's open position on a given side, if any. */
export function findOpenPosition(
  market: Market,
  user: User,
  side: Side,
): Position | undefined {
  return market.positions.find(
    (p) =>
      p.wallet === user.wallet &&
      p.side === side &&
      (p.status === "open" || p.status === "locked"),
  );
}

/** Find or create — creates a fresh open position if none exists. */
export function findOrCreatePosition(
  market: Market,
  user: User,
  side: Side,
  now: Date,
): Position {
  const existing = findOpenPosition(market, user, side);
  if (existing) return existing;
  const created: Position = {
    id: nextPositionId(),
    wallet: user.wallet,
    marketId: market.id,
    side,
    shares: 0,
    averageEntryPriceCents: 0,
    costBasisTroll: 0,
    realizedPnlTroll: 0,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  market.positions.push(created);
  return created;
}

/**
 * Current mark-to-market value of a position, in simulated TROLL.
 * Uses the displayed (clamped) price.
 */
export function calculatePositionValue(position: Position, market: Market): number {
  const { yes, no } = getPrices(market.amm);
  const px = position.side === "YES" ? yes : no;
  return position.shares * px;
}

/** Cumulative realized PnL for this position in TROLL. */
export function calculateRealizedPnL(position: Position): number {
  return position.realizedPnlTroll;
}

/** Unrealized PnL (mark-to-market value − cost basis), in TROLL. */
export function calculateUnrealizedPnL(position: Position, market: Market): number {
  return calculatePositionValue(position, market) - position.costBasisTroll;
}

/** Sum of `costBasisTroll` across all open/locked positions in a market. */
export function sumOpenInterest(market: Market): number {
  return market.positions
    .filter((p) => p.status === "open" || p.status === "locked")
    .reduce((acc, p) => acc + p.costBasisTroll, 0);
}

/** All positions (any status) belonging to a wallet, across markets. */
export function listUserPositions(markets: Market[], wallet: string): Position[] {
  return markets.flatMap((m) => m.positions.filter((p) => p.wallet === wallet));
}
