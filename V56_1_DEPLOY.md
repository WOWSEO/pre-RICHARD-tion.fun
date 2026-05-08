# v56.1 — Fix market-ID collision on server restart

## The bug

`src/market/scheduler.ts` had a global in-memory counter for market IDs:

```js
let _marketCounter = 0;
function nextMarketId(symbol, schedule) {
  return `${symbol}-${schedule}-${++_marketCounter}`;
}
```

Two problems:

1. The counter was **global across all coins and schedules**, not per-(coin, schedule). So IDs were non-monotonic per pair — e.g. TROLL-15m-68 was created later than TROLL-15m-72 because the global counter happened to land at 68 by the time TROLL-15m's turn came up after a restart.
2. The counter **reset to 0 on every Render redeploy**. After your push of v54.3-v56 today, Render redeployed, counter started at 0, and the seeder began trying to insert IDs (TROLL-15m-1, TROLL-15m-2, ...) that collided with old voided rows in your DB. The 23505 unique-violation handler returned `race_lost` because the partial active-status lookup found nothing — the collision was on the **primary key**, not the partial index.

This is why TROLL-15m specifically has been stuck for 2+ hours showing `race_lost` in your seed-markets diagnostic.

## The fix

Replace the counter with a timestamp-based ID:

```js
function nextMarketId(symbol, schedule) {
  const epoch36 = Date.now().toString(36);              // 8 chars now, monotonic
  const rand36 = Math.floor(Math.random() * 36**4)
    .toString(36)
    .padStart(4, "0");                                  // 4 chars random
  return `${symbol}-${schedule}-${epoch36}${rand36}`;
}
```

- Monotonic by wall-clock time (sortable).
- Unique across server restarts (no in-memory state).
- Unique across parallel processes (random suffix protects against same-ms collisions).
- Old IDs in the DB stay untouched. This only affects markets created from now on.

## File

- `src/market/scheduler.ts` — `nextMarketId()` rewritten

## Verified

- `npm run typecheck` — clean
- `npm test` — 48/48 passing
- `npm run build` / `npm run build:server` — clean

## Deploy

```
unzip the patch
git add src/market/scheduler.ts
git commit -m "v56.1: timestamp-based market IDs, fixes restart-collision"
git push origin main
```

Render redeploys. Within one minute the seed-markets cron tick will create a fresh TROLL-15m with a new-format ID like `TROLL-15m-mfp2k8x9z3a7`. Verify by hard-refreshing the site — the 12th market slot fills.

## Want it back IMMEDIATELY without waiting for cron?

Run this in Supabase right after pushing (NOT before — needs the new code live first because the open_price comes from the live snapshot path):

```sql
-- Manual TROLL-15m seed.  Force-creates a market with a guaranteed-unique
-- ID so the seeder doesn't have to wait for the next 15m boundary.
-- Replace TARGET_MC with the current $TROLL MC in dollars (e.g. 47500000).
insert into markets (
  id, symbol, coin_mint, question, schedule_type, target_mc,
  close_at, lock_at, window_seconds, poll_cadence_seconds, status,
  amm_b, amm_q_yes, amm_q_no, yes_price_cents, no_price_cents,
  created_by, market_kind
) values (
  'TROLL-15m-manual-' || extract(epoch from now())::text,
  'TROLL',
  '5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2',
  'Will $TROLL be over $XX.XXM at the next 15-minute close?',
  '15m',
  47500000,    -- replace with current TROLL MC
  date_trunc('hour', now()) + interval '15 minutes' * (extract(minute from now())::int / 15 + 1),
  date_trunc('hour', now()) + interval '15 minutes' * (extract(minute from now())::int / 15 + 1) - interval '15 seconds',
  30, 5, 'open',
  1000, 0, 0, 50, 50,
  'manual_recovery_v56_1', 'higher_lower'
);
```

The cron-scheduled fix is preferable — wait one minute after deploy, market appears automatically with the right snapshot data.

## Why I missed this earlier

I had no visibility into the production seeder behavior until you pasted the diagnostic JSON. The earlier theories (stuck `settling` row, snapshot fetch failure, threshold trip) were guesses. The `race_lost` reason without a `marketId` was the smoking gun — only possible when the unique violation isn't on the partial active-status index.
