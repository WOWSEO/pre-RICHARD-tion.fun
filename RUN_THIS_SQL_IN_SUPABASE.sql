-- RUN THIS WHOLE FILE IN SUPABASE SQL EDITOR
-- pre-RICHARD-tion.fun production lifecycle + snapshot cache SQL
-- Safe to run more than once.


-- ============================================================================
-- 001_market_lifecycle.sql
-- ============================================================================

-- Migration 001: market lifecycle columns + one-active-per-schedule guard.
--
-- Run AFTER server/db/schema.sql.  Idempotent.
-- (schema.sql also contains these columns for fresh installs; this file is for
-- existing databases that pre-date the higher/lower lifecycle.)

alter table markets
  add column if not exists open_price_usd          numeric,
  add column if not exists open_mc                 numeric,
  add column if not exists open_snapshot_at        timestamptz,
  add column if not exists settlement_price_usd    numeric,
  add column if not exists settlement_mc           numeric,
  add column if not exists settlement_snapshot_at  timestamptz,
  add column if not exists settlement_result       text check (settlement_result in ('YES', 'NO', 'VOID')),
  add column if not exists market_kind             text default 'higher_lower';

-- Hard guarantee: at most one (schedule_type, status ∈ open|locked|settling) row.
-- The seeder also enforces this in code; this index is the belt-and-braces backstop.
create unique index if not exists markets_one_active_per_schedule
  on markets (schedule_type)
  where status in ('open', 'locked', 'settling');

-- Backfill: any pre-existing market that doesn't yet carry market_kind gets
-- the new default. (DEFAULT only applies to new INSERTs, not historical rows.)
update markets set market_kind = 'higher_lower' where market_kind is null;

-- ============================================================================
-- 002_oracle_snapshots.sql
-- ============================================================================

-- Migration 002: oracle_snapshots cache table.
--
-- Run AFTER server/db/schema.sql and 001_market_lifecycle.sql.  Idempotent.
-- (schema.sql also contains the CREATE TABLE for fresh installs.)
--
-- Purpose:
--   DexScreener and GeckoTerminal both rate-limit aggressively (429) when the
--   tick endpoint hits them every minute.  Caching the last successful
--   snapshot lets the seeder fall back to a recent value (default ≤ 5 min old)
--   when both providers fail, so the lifecycle keeps advancing.
--
--   This is intentionally a thin cache — one row per fetch, no upsert.  The
--   seeder reads `ORDER BY created_at DESC LIMIT 1`; rows older than the
--   freshness window are simply ignored at read time.  A periodic cleanup
--   (or a TTL on the row) is left to the operator — at one row/min, growth
--   is ~525k rows/year which Supabase handles trivially.

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

-- Read pattern: the seeder asks "give me the most recent snapshot for this
-- symbol".  This index makes that O(log n).
create index if not exists oracle_snapshots_symbol_created_at_idx
  on oracle_snapshots (symbol, created_at desc);

-- ============================================================================
-- 003_lifecycle_safety.sql
-- ============================================================================

-- Migration 003: safety + lifecycle invariant re-assertion.
--
-- Run AFTER schema.sql and migrations 001 + 002.  Idempotent.  Safe to re-run.
--
-- Why a separate migration:
--   - Schemas evolved across versions; some installs may have an old
--     `markets_created_by_fkey` FK to `users(wallet)` that blocks the seeder
--     (admin actors aren't necessarily wallet-rows).  The current schema.sql
--     does NOT define that FK, but pre-existing databases might still carry
--     it from an earlier version.  This migration drops it idempotently.
--   - The partial unique index `markets_one_active_per_schedule` is the
--     belt-and-braces guarantee that at most one (open|locked|settling) row
--     exists per schedule_type.  Re-asserted here in case a prior migration
--     run dropped it without re-creating.

-- 1. Drop the legacy FK on markets.created_by if it still exists.
do $$
declare
  fk_name text;
begin
  select conname into fk_name
  from pg_constraint
  where conrelid = 'public.markets'::regclass
    and contype = 'f'
    and pg_get_constraintdef(oid) ilike '%(created_by)%users%';
  if fk_name is not null then
    execute format('alter table public.markets drop constraint %I', fk_name);
    raise notice 'Dropped legacy FK %', fk_name;
  end if;
end $$;

-- 2. Ensure created_by is a plain text column (no constraint dependencies).
-- The schema.sql defines this; this is just a re-assertion in case an
-- intermediate schema version had it differently.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'markets' and column_name = 'created_by'
  ) then
    alter table public.markets add column created_by text;
  end if;
end $$;


-- 3a. Ensure markets.status accepts the values used by the production lifecycle.
-- Older databases may only allow ('open','locked','settling','settled') and
-- will reject lifecycle/admin voids unless we replace the legacy check.
alter table public.markets drop constraint if exists markets_status_check;
alter table public.markets
  add constraint markets_status_check
  check (status in ('open', 'locked', 'settling', 'settled', 'voided'));

-- 3b. Ensure the oracle cache table exists even if migration 002 was skipped.
create table if not exists public.oracle_snapshots (
  id              bigserial primary key,
  symbol          text        not null,
  price_usd       numeric     not null,
  market_cap      numeric     not null,
  fdv             numeric,
  source          text        not null,
  raw_payload     jsonb,
  created_at      timestamptz not null default now()
);

-- 3. Re-assert the lifecycle invariant index.
create unique index if not exists markets_one_active_per_schedule
  on markets (schedule_type)
  where status in ('open', 'locked', 'settling');

-- 4. Re-assert the oracle_snapshots index (in case 002 was partially applied).
create index if not exists oracle_snapshots_symbol_created_at_idx
  on oracle_snapshots (symbol, created_at desc);

-- ============================================================================
-- OPTIONAL: stale-test-market cleanup.
--
-- If your DB has stuck markets from earlier deploys (e.g. close_at in the
-- past, status='locked', no real positions), uncomment ONE of the blocks
-- below depending on how aggressive you want to be.  These are commented
-- out by default — the migration is safe to apply without touching them.
-- ============================================================================

-- 4a. SOFT cleanup — mark stuck markets as voided so the seeder can replace
-- them.  Preserves the row for audit, just flips its status.
--
-- update public.markets
--   set status = 'voided',
--       void_reason = 'admin_cleanup_stuck_lifecycle',
--       outcome = 'VOID',
--       settlement_result = 'VOID',
--       settled_at = coalesce(settled_at, now())
-- where status in ('open', 'locked', 'settling')
--   and close_at < now() - interval '15 minutes';

-- 4b. HARD cleanup — delete every market AND its dependent rows.  ONLY use
-- on a dev/staging DB you don't care about; deletes user trade history.
-- Requires CASCADE FKs to be set on dependents (current schema has them).
--
-- delete from public.markets where status in ('open', 'locked', 'settling');
