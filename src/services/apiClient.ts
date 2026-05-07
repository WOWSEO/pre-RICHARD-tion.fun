/**
 * Typed fetch wrapper for the prerichardtion.fun server.
 *
 * Reads `VITE_API_BASE_URL` at build time (e.g. https://api.prerichardtion.fun).
 * If unset, defaults to "/api" — handy when the client is served from the same
 * origin as the API (Vite dev proxy or production reverse-proxy).
 */

import type { Outcome, ScheduleType, Side, TradeQuote } from "../market/marketTypes";

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "/api";

class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(
  path: string,
  init?: RequestInit & { adminKey?: string },
): Promise<T> {
  const url = `${BASE}${path}`;
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (init?.adminKey) {
    headers.set("x-admin-key", init.adminKey);
  }

  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => null);
    }
    const msg =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `request failed: ${res.status}`;
    throw new ApiError(res.status, msg, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ========================================================================== */
/* Wire types — match server/routes/*.ts                                      */
/* ========================================================================== */

export interface MarketSummary {
  id: string;
  symbol: string;
  question: string;
  scheduleType: ScheduleType;
  targetMc: number;
  closeAt: string;
  lockAt: string;
  status: "open" | "locked" | "settling" | "settled" | "voided";
  yesPriceCents: number;
  noPriceCents: number;
  volume: number;
  openInterest: number;
  yesLiquidity: number;
  noLiquidity: number;
  settlementMc: number | null;
  outcome: Outcome | null;
  voidReason: string | null;
  version: number;
}

export interface MarketDetail extends MarketSummary {
  windowSeconds: number;
  positions: WirePosition[];
  trades: WireTrade[];
}

export interface WirePosition {
  id: string;
  wallet: string;
  side: Side;
  shares: number;
  averageEntryPriceCents: number;
  costBasisTroll: number;
  realizedPnlTroll: number;
  status: "open" | "closed" | "locked" | "settled" | "void_refunded";
}

/**
 * v42: shape returned by GET /api/positions?wallet=... — note this is the
 * raw snake_case row from the positions table (the server doesn't transform
 * this list endpoint), not the camelCase WirePosition assembled inside
 * market detail responses.
 */
export interface UserPositionRow {
  id: string;
  market_id: string;
  wallet: string;
  side: "YES" | "NO";
  shares: string;                      // numeric stored as string
  average_entry_price_cents: string;
  cost_basis_troll: string;
  realized_pnl_troll: string;
  status: "open" | "closed" | "locked" | "settled" | "void_refunded";
  created_at: string;
  updated_at: string;
}

export interface WireTrade {
  id: string;
  wallet: string;
  action: "buy_yes" | "buy_no" | "sell_yes" | "sell_no";
  amountTroll: number;
  shares: number;
  priceCents: number;
  avgPriceCents: number;
  priceBeforeCents: number;
  priceAfterCents: number;
  timestamp: string;
}

export interface WireWithdrawal {
  id: number;
  market_id: string;
  wallet: string;
  amount_troll: string;
  reason: "exit" | "payout" | "refund";
  status: "pending" | "sent" | "confirmed" | "failed";
  signature: string | null;
  failure_reason: string | null;
  position_id: string | null;
  created_at: string;
  sent_at: string | null;
  confirmed_at: string | null;
}

export interface MarketsListResponse {
  markets: MarketSummary[];
  escrowAccount: string;
  /** v23: native SOL escrow address (= authority pubkey). */
  escrowSolAccount?: string;
}

/* ========================================================================== */
/* Public API                                                                 */
/* ========================================================================== */

export const api = {
  health: () => call<{ ok: boolean; time: string }>("/health"),

  listMarkets: () => call<MarketsListResponse>("/markets"),

  getMarket: (id: string) =>
    call<{ market: MarketDetail; escrowAccount: string; escrowSolAccount?: string }>(
      `/markets/${encodeURIComponent(id)}`,
    ),

  /**
   * v23: quote accepts currency.  Server returns the canonical SOL-equivalent
   * pricing alongside the conversion details for UI display.  Legacy callers
   * passing only amountTroll continue to work (server defaults currency='troll').
   */
  quote: (
    id: string,
    side: Side,
    amount: number,
    currency: "troll" | "sol" = "troll",
  ) =>
    call<{
      quote: TradeQuote;
      conversion?: {
        inputCurrency: "troll" | "sol";
        amountInput: number;
        amountSolEquiv: number;
        trollPriceUsd: number;
        solPriceUsd: number;
      };
    }>(`/markets/${encodeURIComponent(id)}/quote`, {
      method: "POST",
      body: JSON.stringify({ side, amount, currency }),
    }),

  enter: (
    id: string,
    args: {
      wallet: string;
      side: Side;
      signature: string;
      // v23: prefer {currency, amount}.  Legacy callers may still send
      // amountTroll alone; server treats that as currency='troll'.
      amount?: number;
      currency?: "troll" | "sol";
      amountTroll?: number;
    },
  ) =>
    call<{
      ok: boolean;
      depositId: number;
      tradeId: string;
      positionId: string;
      market: MarketDetail;
    }>(`/markets/${encodeURIComponent(id)}/enter`, {
      method: "POST",
      body: JSON.stringify(args),
    }),

  exit: (
    positionId: string,
    args: { wallet: string; sharesToSell?: number },
  ) =>
    call<{
      ok: boolean;
      withdrawalId: number;
      proceedsTroll: number;
      tradeId: string;
      market: MarketDetail;
    }>(`/positions/${encodeURIComponent(positionId)}/exit`, {
      method: "POST",
      body: JSON.stringify(args),
    }),

  myPositions: (wallet: string) =>
    call<{ positions: UserPositionRow[] }>(`/positions?wallet=${encodeURIComponent(wallet)}`),

  myWithdrawals: (wallet: string) =>
    call<{ withdrawals: WireWithdrawal[] }>(
      `/positions/withdrawals?wallet=${encodeURIComponent(wallet)}`,
    ),

  /**
   * User-driven claim.  Triggers the server to send the SPL transfer for one
   * pending withdrawal.  Idempotent against concurrent claim/cron — the
   * server's atomic CAS means at most one process can transition pending→sent.
   */
  claimWithdrawal: (withdrawalId: number, wallet: string) =>
    call<{
      ok: boolean;
      status: "confirmed" | "sent";
      signature?: string;
      reason?: string;
    }>(`/positions/withdrawals/${withdrawalId}/claim`, {
      method: "POST",
      body: JSON.stringify({ wallet }),
    }),

  audit: (marketId: string) =>
    call<{ receipt: AuditWire }>(`/audit/${encodeURIComponent(marketId)}`),

  /* Admin */
  adminOverview: (adminKey: string) =>
    call<AdminOverview>("/admin/overview", { adminKey }),

  createMarket: (
    adminKey: string,
    body: { scheduleType: ScheduleType },
  ) =>
    call<{
      ok: boolean;
      created: boolean;
      marketId: string | null;
      reason: string | null;
      openMc: number | null;
      openPriceUsd: number | null;
      openSource: "dexscreener" | "geckoterminal" | "manual" | null;
    }>("/admin/markets", {
      method: "POST",
      adminKey,
      body: JSON.stringify(body),
    }),

  /** Walk all 3 schedule types and seed any empty slot. */
  seedMarkets: (adminKey: string) =>
    call<{
      ok: boolean;
      results: Array<{
        scheduleType: ScheduleType;
        created: boolean;
        marketId: string | null;
        reason: string | null;
        openMc: number | null;
        openPriceUsd: number | null;
        openSource: "dexscreener" | "geckoterminal" | "manual" | null;
      }>;
    }>("/admin/seed-markets", {
      method: "POST",
      adminKey,
      body: JSON.stringify({}),
    }),

  voidMarket: (adminKey: string, marketId: string, reason?: string) =>
    call<{ ok: boolean }>("/admin/void-market", {
      method: "POST",
      adminKey,
      body: JSON.stringify({ marketId, reason }),
    }),

  triggerSettle: (adminKey: string, marketId: string) =>
    call<{
      ok: boolean;
      outcome: "YES" | "NO" | "VOID";
      voidReason: string | null;
      canonicalMc: number | null;
      userSettlements: number;
      withdrawalsQueued: number;
    }>("/admin/settle", {
      method: "POST",
      adminKey,
      body: JSON.stringify({ marketId }),
    }),

  runPayouts: (adminKey: string, limit = 50) =>
    call<{ ok: boolean; processed: number }>("/admin/payouts/run", {
      method: "POST",
      adminKey,
      body: JSON.stringify({ limit }),
    }),
};

export interface AuditWire {
  market_id: string;
  question: string;
  target_mc: string;
  close_at: string;
  schedule_type: string;
  source_medians: Record<string, number>;
  canonical_mc: string | null;
  outcome: string;
  void_reason: string | null;
  final_yes_price_cents: string;
  final_no_price_cents: string;
  user_settlements: unknown[];
  snapshot_bundle: unknown;
  snapshot_bundle_hash: string;
  created_at: string;
}

export interface AdminOverview {
  escrowAccount: string;
  escrowConfirmedTotal: number;
  pendingWithdrawalTotal: number;
  markets: Array<{
    id: string;
    question: string;
    schedule_type: string;
    target_mc: string;
    close_at: string;
    status: string;
    yes_price_cents: string;
    no_price_cents: string;
    volume: string;
    open_interest: string;
  }>;
  recentDeposits: Array<{
    id: number;
    signature: string;
    market_id: string;
    wallet: string;
    amount_troll: string;
    status: string;
    failure_reason: string | null;
    side: string;
    created_at: string;
  }>;
  recentWithdrawals: Array<{
    id: number;
    market_id: string;
    wallet: string;
    amount_troll: string;
    reason: string;
    status: string;
    signature: string | null;
    failure_reason: string | null;
    created_at: string;
  }>;
}

export { ApiError };
