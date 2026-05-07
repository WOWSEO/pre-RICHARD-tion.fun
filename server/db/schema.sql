-- prerichardtion.fun — server-side schema (audit-hardened)
-- Run this once in Supabase SQL editor. All numeric balances stored as TEXT to
-- avoid double-precision errors on token amounts; we'll cast to numeric when math is needed.
--
-- AUDIT NOTES (changed from prior version):
--   1. `audit_receipts` is now declared BEFORE `settlements`. The previous version
--      had `settlements` reference `audit_receipts(market_id)` while the receipts
--      table was declared later in the file — `deferrable initially deferred`
--      defers constraint *checking*, not constraint *creation*, so the migration
--      would fail on a fresh DB with "relation audit_receipts does not exist".
--   2. `markets.created_by` is no longer a FK to `users(wallet)`. Admins create
--      markets without ever holding a wallet row, and we'd rather log the actor
--      string than fail the insert.
--   3. `escrow_withdrawals.signature` is now UNIQUE — keeps payout idempotency
--      tight if a worker retries after a partial confirmation.

-- ============================================================================
-- USERS
-- ============================================================================
create table if not exists users (
  wallet              text primary key,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  display_handle      text,
  cached_troll_balance numeric default 0
);

-- ============================================================================
-- SUPPORTED COINS — registry of bettable tokens (v53+)
-- ============================================================================
-- Each row is a token that the seeder will spawn markets for, and that the
-- frontend will display in the coin-selector tile UI.  Per-coin settlement
-- floors live here so liquid coins and thin coins can have different rules.
create table if not exists supported_coins (
  mint                  text primary key,
  symbol                text not null,
  name                  text not null,
  dexscreener_pair_url  text not null,
  geckoterminal_url     text not null,
  dexscreener_embed_url text not null,
  geckoterminal_pool_url text not null,
  image_url             text,
  min_liquidity_usd     numeric not null default 25000,
  min_volume_24h_usd    numeric not null default 10000,
  is_active             boolean not null default true,
  display_order         integer not null default 1000,
  created_at            timestamptz not null default now()
);

-- ============================================================================
-- MARKETS — one row per prediction window, mirrors brain's Market type
-- ============================================================================
create table if not exists markets (
  id                  text primary key,
  symbol              text not null default 'TROLL',
  -- v53 — multi-coin support.  Foreign-keyish reference to supported_coins.mint.
  coin_mint           text not null default '5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2',
  question            text not null,
  schedule_type       text not null check (schedule_type in ('15m', 'hourly', 'daily')),
  target_mc           numeric not null,
  close_at            timestamptz not null,
  lock_at             timestamptz not null,
  window_seconds      integer not null,
  poll_cadence_seconds integer not null,
  status              text not null default 'open' check (status in ('open', 'locked', 'settling', 'settled', 'voided')),

  -- AMM book state (LMSR)
  amm_b               numeric not null default 1000,
  amm_q_yes           numeric not null default 0,
  amm_q_no            numeric not null default 0,

  -- Display-clamped prices in cents [1, 99]
  yes_price_cents     numeric not null default 50,
  no_price_cents      numeric not null default 50,
  yes_liquidity       numeric not null default 0,
  no_liquidity        numeric not null default 0,
  volume              numeric not null default 0,
  open_interest       numeric not null default 0,

  -- Settlement output (legacy + new lifecycle columns).
  -- `outcome` and `settlement_mc` predate the higher/lower lifecycle.
  -- The new columns below are written alongside on settlement so analytics
  -- and the audit page can read whichever name they prefer.
  settlement_mc       numeric,
  outcome             text check (outcome in ('YES', 'NO', 'VOID')),
  void_reason         text,
  open_price_usd          numeric,
  open_mc                 numeric,
  open_snapshot_at        timestamptz,
  settlement_price_usd    numeric,
  settlement_snapshot_at  timestamptz,
  settlement_result       text check (settlement_result in ('YES', 'NO', 'VOID')),
  market_kind             text default 'higher_lower',

  -- Audit trail.  `created_by` is NOT a FK — admin actors aren't always wallets.
  created_at          timestamptz not null default now(),
  created_by          text,
  settled_at          timestamptz,

  -- Concurrency token — bump on every state change so optimistic updates can detect conflicts
  version             bigint not null default 0
);
create index if not exists markets_status_idx on markets(status);
create index if not exists markets_close_at_idx on markets(close_at);

-- LIFECYCLE INVARIANT: at most one active market per schedule_type.
-- The seeder enforces this in code; this partial unique index is the backstop.
create unique index if not exists markets_one_active_per_coin_schedule
  on markets (coin_mint, schedule_type)
  where status in ('open', 'locked', 'settling');

-- v53 — index for filtering markets by coin_mint
create index if not exists markets_coin_mint_idx on markets (coin_mint);

-- ============================================================================
-- MARKET SNAPSHOTS — every poll during the close window
-- ============================================================================
create table if not exists market_snapshots (
  id                  bigserial primary key,
  market_id           text not null references markets(id) on delete cascade,
  source              text not null check (source in ('dexscreener', 'geckoterminal', 'helius', 'mock')),
  fetched_at          timestamptz not null default now(),
  market_cap_usd      numeric,
  price_usd           numeric,
  liquidity_usd       numeric,
  volume_24h_usd      numeric,
  ok                  boolean not null,
  error_text          text,
  raw_payload         jsonb
);
create index if not exists market_snapshots_market_idx on market_snapshots(market_id, source, fetched_at);

-- ============================================================================
-- TRADES — one row per buy_yes / buy_no / sell_yes / sell_no
-- Note: the brain emits trade IDs.  The server overrides the generator with
-- crypto.randomUUID()-based IDs at boot so the PK never collides across server restarts.
-- ============================================================================
create table if not exists trades (
  id                  text primary key,
  market_id           text not null references markets(id) on delete cascade,
  wallet              text not null references users(wallet),
  action              text not null check (action in ('buy_yes', 'buy_no', 'sell_yes', 'sell_no')),
  amount_troll        numeric not null,
  shares              numeric not null,
  price_cents         numeric not null,
  avg_price_cents     numeric not null,
  price_before_cents  numeric not null,
  price_after_cents   numeric not null,
  -- on-chain link — for buys, the deposit signature; for sells, the payout signature once sent
  escrow_signature    text,
  created_at          timestamptz not null default now()
);
create index if not exists trades_market_idx on trades(market_id, created_at);
create index if not exists trades_wallet_idx on trades(wallet, created_at);

-- ============================================================================
-- POSITIONS — one row per (wallet, market, side)
-- ============================================================================
create table if not exists positions (
  id                          text primary key,
  market_id                   text not null references markets(id) on delete cascade,
  wallet                      text not null references users(wallet),
  side                        text not null check (side in ('YES', 'NO')),
  shares                      numeric not null default 0,
  average_entry_price_cents   numeric not null default 50,
  cost_basis_troll            numeric not null default 0,
  realized_pnl_troll          numeric not null default 0,
  status                      text not null default 'open' check (status in ('open', 'closed', 'locked', 'settled', 'void_refunded')),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (market_id, wallet, side)
);
create index if not exists positions_market_idx on positions(market_id);
create index if not exists positions_wallet_idx on positions(wallet);
create index if not exists positions_status_idx on positions(status);

-- ============================================================================
-- ESCROW DEPOSITS — verified on-chain SPL transfers from user → market escrow
-- The unique on `signature` is the primary defense against signature replay.
-- ============================================================================
create table if not exists escrow_deposits (
  id                  bigserial primary key,
  signature           text unique not null,
  market_id           text not null references markets(id) on delete cascade,
  wallet              text not null references users(wallet),
  amount_troll        numeric not null,
  status              text not null default 'pending' check (status in ('pending', 'confirmed', 'failed')),
  failure_reason      text,
  side                text not null check (side in ('YES', 'NO')),
  trade_id            text references trades(id),
  position_id         text references positions(id),
  created_at          timestamptz not null default now(),
  confirmed_at        timestamptz
);
create index if not exists escrow_deposits_market_idx on escrow_deposits(market_id);
create index if not exists escrow_deposits_wallet_idx on escrow_deposits(wallet);
create index if not exists escrow_deposits_status_idx on escrow_deposits(status);

-- ============================================================================
-- ESCROW WITHDRAWALS — payouts (winners), refunds (voids), exits (pre-lock sells)
-- Statuses progress: pending → sent → confirmed (or → failed)
-- The atomic claim is `UPDATE ... WHERE status='pending' RETURNING *` — only
-- one worker wins the CAS; others see "not_claimable".
-- ============================================================================
create table if not exists escrow_withdrawals (
  id                  bigserial primary key,
  market_id           text not null references markets(id) on delete cascade,
  wallet              text not null references users(wallet),
  amount_troll        numeric not null,
  reason              text not null check (reason in ('exit', 'payout', 'refund')),
  status              text not null default 'pending' check (status in ('pending', 'sent', 'confirmed', 'failed')),
  signature           text unique,
  failure_reason      text,
  position_id         text references positions(id),
  trade_id            text references trades(id),
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  confirmed_at        timestamptz
);
create index if not exists escrow_withdrawals_status_idx on escrow_withdrawals(status);
create index if not exists escrow_withdrawals_wallet_idx on escrow_withdrawals(wallet);

-- ============================================================================
-- AUDIT RECEIPTS — declared BEFORE settlements because settlements references it.
-- ============================================================================
create table if not exists audit_receipts (
  market_id           text primary key references markets(id) on delete cascade,
  question            text not null,
  target_mc           numeric not null,
  close_at            timestamptz not null,
  schedule_type       text not null,
  source_medians      jsonb not null,
  canonical_mc        numeric,
  outcome             text not null,
  void_reason         text,
  final_yes_price_cents numeric not null,
  final_no_price_cents  numeric not null,
  user_settlements    jsonb not null,
  snapshot_bundle     jsonb not null,
  snapshot_bundle_hash text not null,
  created_at          timestamptz not null default now()
);

-- ============================================================================
-- SETTLEMENTS — one row per settled or voided market
-- ============================================================================
create table if not exists settlements (
  market_id           text primary key references markets(id) on delete cascade,
  outcome             text not null check (outcome in ('YES', 'NO', 'VOID')),
  void_reason         text,
  canonical_mc        numeric,
  source_medians      jsonb not null,
  snapshot_count      integer not null,
  settled_at          timestamptz not null default now(),
  -- audit_receipts is now declared above, so this FK resolves at table creation.
  audit_receipt_id    text references audit_receipts(market_id) deferrable initially deferred
);

-- ============================================================================
-- ADMIN ACTIONS — every privileged write is logged
-- ============================================================================
create table if not exists admin_actions (
  id                  bigserial primary key,
  actor               text not null,
  action              text not null,
  payload             jsonb,
  result              text not null check (result in ('ok', 'error')),
  error_text          text,
  created_at          timestamptz not null default now()
);

-- ============================================================================
-- Row Level Security
-- All writes go through the server using the service-role key, which bypasses RLS.
-- Public read policies are exposed for market data only.
-- ============================================================================
alter table users               enable row level security;
alter table markets             enable row level security;
alter table market_snapshots    enable row level security;
alter table trades              enable row level security;
alter table positions           enable row level security;
alter table escrow_deposits     enable row level security;
alter table escrow_withdrawals  enable row level security;
alter table settlements         enable row level security;
alter table audit_receipts      enable row level security;
alter table admin_actions       enable row level security;

-- Idempotent policy creation (re-run-safe).
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'markets'         and policyname = 'public read markets')         then create policy "public read markets"         on markets         for select using (true); end if;
  if not exists (select 1 from pg_policies where tablename = 'trades'          and policyname = 'public read trades')          then create policy "public read trades"          on trades          for select using (true); end if;
  if not exists (select 1 from pg_policies where tablename = 'positions'       and policyname = 'public read positions')       then create policy "public read positions"       on positions       for select using (true); end if;
  if not exists (select 1 from pg_policies where tablename = 'settlements'     and policyname = 'public read settlements')     then create policy "public read settlements"     on settlements     for select using (true); end if;
  if not exists (select 1 from pg_policies where tablename = 'audit_receipts'  and policyname = 'public read audit')           then create policy "public read audit"            on audit_receipts  for select using (true); end if;
  if not exists (select 1 from pg_policies where tablename = 'market_snapshots' and policyname = 'public read snapshots')      then create policy "public read snapshots"        on market_snapshots for select using (true); end if;
end $$;

-- No public write policies are defined.  All mutations go through the Express
-- server, which uses SUPABASE_SERVICE_ROLE_KEY (bypasses RLS).

-- ============================================================================
-- oracle_snapshots — cache for the tick endpoint's live MC reads.
-- Added by migration 002 for new installs; the migration file applies the
-- same DDL idempotently to existing installs.
-- ============================================================================
create table if not exists oracle_snapshots (
  id              bigserial primary key,
  symbol          text        not null,
  price_usd       numeric     not null,
  market_cap      numeric     not null,
  fdv             numeric,
  source          text        not null,
  raw_payload     jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists oracle_snapshots_symbol_created_at_idx
  on oracle_snapshots (symbol, created_at desc);
alter table oracle_snapshots enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'oracle_snapshots' and policyname = 'public read oracle snapshots')
  then create policy "public read oracle snapshots" on oracle_snapshots for select using (true); end if;
end $$;
