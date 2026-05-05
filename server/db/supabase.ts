import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "../env";

/* ========================================================================== */
/* DB row types — match server/db/schema.sql                                  */
/* ========================================================================== */

export interface UserRow {
  wallet: string;
  first_seen_at: string;
  last_seen_at: string;
  display_handle: string | null;
  cached_troll_balance: string;
}

export interface MarketRow {
  id: string;
  symbol: string;
  question: string;
  schedule_type: "15m" | "hourly" | "daily";
  target_mc: string;
  close_at: string;
  lock_at: string;
  window_seconds: number;
  poll_cadence_seconds: number;
  status: "open" | "locked" | "settling" | "settled" | "voided";
  amm_b: string;
  amm_q_yes: string;
  amm_q_no: string;
  yes_price_cents: string;
  no_price_cents: string;
  yes_liquidity: string;
  no_liquidity: string;
  volume: string;
  open_interest: string;
  settlement_mc: string | null;
  outcome: "YES" | "NO" | "VOID" | null;
  void_reason: string | null;
  created_at: string;
  created_by: string | null;
  settled_at: string | null;
  version: number;
  // Higher/lower lifecycle columns (added by 001_market_lifecycle migration).
  // Nullable to keep the type compatible with rows from pre-migration installs;
  // populated unconditionally by the v7+ seeder and settlement orchestrator.
  open_price_usd: string | null;
  open_mc: string | null;
  open_snapshot_at: string | null;
  settlement_price_usd: string | null;
  settlement_snapshot_at: string | null;
  settlement_result: "YES" | "NO" | "VOID" | null;
  market_kind: string | null;
}

export interface TradeRow {
  id: string;
  market_id: string;
  wallet: string;
  action: "buy_yes" | "buy_no" | "sell_yes" | "sell_no";
  amount_troll: string;
  shares: string;
  price_cents: string;
  avg_price_cents: string;
  price_before_cents: string;
  price_after_cents: string;
  escrow_signature: string | null;
  created_at: string;
}

export interface PositionRow {
  id: string;
  market_id: string;
  wallet: string;
  side: "YES" | "NO";
  shares: string;
  average_entry_price_cents: string;
  cost_basis_troll: string;
  realized_pnl_troll: string;
  status: "open" | "closed" | "locked" | "settled" | "void_refunded";
  created_at: string;
  updated_at: string;
}

export interface EscrowDepositRow {
  id: number;
  signature: string;
  market_id: string;
  wallet: string;
  amount_troll: string;
  status: "pending" | "confirmed" | "failed";
  failure_reason: string | null;
  side: "YES" | "NO";
  trade_id: string | null;
  position_id: string | null;
  created_at: string;
  confirmed_at: string | null;
}

export interface EscrowWithdrawalRow {
  id: number;
  market_id: string;
  wallet: string;
  amount_troll: string;
  reason: "exit" | "payout" | "refund";
  status: "pending" | "sent" | "confirmed" | "failed";
  signature: string | null;
  failure_reason: string | null;
  position_id: string | null;
  trade_id: string | null;
  created_at: string;
  sent_at: string | null;
  confirmed_at: string | null;
}

export interface SettlementRow {
  market_id: string;
  outcome: "YES" | "NO" | "VOID";
  void_reason: string | null;
  canonical_mc: string | null;
  source_medians: Record<string, number>;
  snapshot_count: number;
  settled_at: string;
}

export interface AuditReceiptRow {
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

export interface MarketSnapshotRow {
  id: number;
  market_id: string;
  source: string;
  fetched_at: string;
  market_cap_usd: string | null;
  price_usd: string | null;
  liquidity_usd: string | null;
  volume_24h_usd: string | null;
  ok: boolean;
  error_text: string | null;
  raw_payload: unknown;
}

/**
 * oracle_snapshots — cache for the tick endpoint's live $TROLL MC reads.
 *
 * One row per successful provider call.  The seeder reads
 * `ORDER BY created_at DESC LIMIT 1` and gates on freshness in app code
 * (default 5-minute TTL).
 */
export interface OracleSnapshotRow {
  id: number;
  symbol: string;
  price_usd: string;
  market_cap: string;
  fdv: string | null;
  source: string;
  raw_payload: unknown;
  created_at: string;
}

/* ========================================================================== */
/* Client bootstrap                                                           */
/* ========================================================================== */

let _client: SupabaseClient | null = null;

/**
 * The server uses the **service role key** which bypasses RLS. NEVER expose this
 * key to the browser. Routes/services validate caller identity themselves.
 */
export function db(): SupabaseClient {
  if (_client) return _client;
  const env = loadEnv();
  _client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

/** Helper: parse numeric string columns into JS numbers safely. */
export function num(s: string | null | undefined): number {
  if (s == null) return 0;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
