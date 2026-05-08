# v56.3 — MyPositions attached to predict, double-spend fix, error recovery

Three real bugs from tonight, fixed:

## 1. MyPositions now attached to the predict card

Wrapped the predict aside in a `.classic-right-column` flex container with MyPositions inside it. They stack vertically in the same column, share width and right-edge alignment. Always visible, no overlap. The chart strip goes back to spanning the full bottom-left.

## 2. Auto-refund double-spend fix (server)

The "internal_error" you saw was the v54.6 outer catch firing after the position was already created. It then unconditionally marked the deposit failed AND queued a refund. Result: user got both a position AND a refund of their stake.

Fix: outer catch now reads the deposit row first. If `status='confirmed'` or `position_id` or `trade_id` are set, the bet went through — skip the refund queue. Logs a `bet went through, NOT queueing auto-refund` warning.

## 3. Frontend error recovery (client)

When /enter throws, the frontend now polls `/api/positions` four times over ~6 seconds before showing "Try again". If the position shows up, treats it as success. Prevents the double-click double-spend you hit twice tonight.

## Files

- `src/App.tsx`
- `src/index.css`  
- `server/routes/markets.ts`

## Verified

- `npm run typecheck`, `npm test` 48/48, `npm run build`, `npm run build:server` — all clean

## Deploy

```
unzip the patch
git add src/App.tsx src/index.css server/routes/markets.ts
git commit -m "v56.3: MyPositions attached to predict overlay, double-spend fix, error recovery"
git push origin main
```

## For the settlement-not-paying-out issue

Run this in Supabase, paste the result:

```sql
select id, status, outcome, settlement_result, void_reason, settlement_mc, settled_at
  from markets
 where coin_mint = '2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y'
   and schedule_type = '15m'
   and status in ('settled', 'voided')
 order by settled_at desc
 limit 3;

select market_id, wallet, amount_troll, reason, status, failure_reason, signature, created_at
  from escrow_withdrawals
 where market_id in (
   select id from markets
    where coin_mint = '2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y'
      and schedule_type = '15m'
    order by settled_at desc nulls last limit 3
 )
 order by created_at desc;
```

Three possible diagnoses depending on what comes back:
- Market voided (no_opposition / source_disagreement) → both wallets get refunds, no winner to pay
- Market settled cleanly but no withdrawal rows → settlement orchestrator skipped queue step
- Withdrawal rows pending or failed → payouts cron issue

I can give you the exact unblock SQL once I see the data.
