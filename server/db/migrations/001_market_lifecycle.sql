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
