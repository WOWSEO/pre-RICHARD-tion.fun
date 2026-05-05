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
