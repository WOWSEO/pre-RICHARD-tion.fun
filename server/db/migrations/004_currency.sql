-- =========================================================================
-- v23 — multi-currency betting (TROLL + SOL)
--
-- Product rule:
--   Users bet in EITHER TROLL or SOL.  Internally every bet is normalized
--   to SOL using the entry-time TROLL/SOL price.  Settlement payouts ALWAYS
--   go out in SOL regardless of which currency was deposited.
--
-- Schema changes:
--   1. escrow_deposits: add `currency` ('troll' | 'sol') and
--      `amount_sol_equiv` (numeric SOL value at entry — pinned).  TROLL
--      deposits always populate amount_sol_equiv with the converted value.
--      SOL deposits set both amount_troll and amount_sol_equiv to the same
--      SOL number (amount_troll keeps the legacy column populated as the
--      internal accounting unit; the brain treats it as a unit-agnostic
--      ledger).
--   2. escrow_withdrawals: add `currency` ('troll' | 'sol').  Default 'sol'
--      because v23 onward EVERY withdrawal pays out in SOL.  The 'troll'
--      value is reserved for legacy rows that existed before this migration.
--
-- Backward compat:
--   - Existing rows get currency='troll' (deposits) or currency='troll'
--     (withdrawals) so the existing payout engine keeps processing them
--     as SPL transfers.
--   - amount_sol_equiv is NULLABLE — old rows don't have it.  The brain
--     uses amount_troll for math; this column is purely audit + the
--     currency-aware payout engine reads it.
--   - The brain's tradeEngine is unchanged; "amount_troll" is now the
--     unit-agnostic ledger and downstream code treats it as SOL.
-- =========================================================================

-- Deposits
alter table public.escrow_deposits
  add column if not exists currency text not null default 'troll'
    check (currency in ('troll', 'sol'));

alter table public.escrow_deposits
  add column if not exists amount_sol_equiv numeric;

-- Withdrawals
alter table public.escrow_withdrawals
  add column if not exists currency text not null default 'troll'
    check (currency in ('troll', 'sol'));

-- New rows from v23 onward MUST set currency explicitly; the default just
-- exists so the migration doesn't break on existing data.

-- Indexes for the payout engine — it filters by status + currency so it
-- can dispatch to the right transfer path.
create index if not exists idx_escrow_withdrawals_currency_status
  on public.escrow_withdrawals (currency, status);

-- Audit trail: a user-friendly view that joins deposits with their
-- recorded currency and SOL-equivalent for the admin console.
-- Can be skipped at run time without affecting the app.
do $$
begin
  if not exists (select 1 from pg_class where relname = 'v_deposits_with_currency') then
    create view public.v_deposits_with_currency as
      select
        id, signature, market_id, wallet,
        currency,
        amount_troll,
        amount_sol_equiv,
        status, created_at
      from public.escrow_deposits;
  end if;
end$$;
