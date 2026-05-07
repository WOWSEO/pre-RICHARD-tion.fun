# v53 — Parimutuel + Multi-Coin Patch

## What's in this patch

**Parimutuel rewrite (math layer)**
- `src/market/settlementEngine.ts` — winners split losers' pool, 3% fee on winners only, refunds get full stake (no fee)
- `src/market/tradeEngine.ts` — buys add stake 1:1 to YES/NO pool, sells blocked
- `src/market/pricingEngine.ts` — odds = pool ratio, displayed as cents
- `src/market/positionEngine.ts`, `marketTypes.ts`, `scheduler.ts`, `auditReceipt.ts` — supporting changes
- `src/tests/parimutuel.test.ts` — 16 new tests including the 1v1 NO-winner case that LMSR couldn't settle
- `server/services/payoutEngine.ts` — fee-on-winners gate (`reason === "payout"|"exit"` triggers fee; `"refund"` skips it)

**Multi-coin support (TROLL + USDUC + BUTT)**
- `server/db/migrations/005_multi_coin.sql` — **YOU MUST RUN THIS IN SUPABASE FIRST** (see step 1 below)
- `server/db/schema.sql` — fresh-install matching version
- `src/config/coins.ts` — registry of TROLL, USDUC, BUTT
- `src/config/troll.ts` — now a thin compat re-export
- `server/services/marketSnapshot.ts` — `fetchCoinSnapshot(coin)`, providers per-coin
- `server/services/marketSeeder.ts` — seeds 3 coins × 3 schedules = 9 markets
- `server/services/settlementOrchestrator.ts` — settles with the right coin's config
- `server/routes/coins.ts` — new `GET /api/coins` route
- `server/routes/markets.ts` — `GET /api/markets?coin=<mint>` filter, `coinMint` on responses
- `server/routes/admin.ts` — `POST /api/admin/markets` accepts `{coinMint}`
- `src/services/apiClient.ts` — `listCoins()`, `listMarkets({coin})`

**Other (catch-up: not previously committed)**
- `src/components/Footer.tsx`, `Legal.tsx`, `MyPositions.tsx`
- `server/services/escrowReconciler.ts`
- `SECURITY.md`, `.gitignore`, `.env.example`

## Verified before zip

- `npm run typecheck` — clean
- `npm test` — 36/36 passing (including new parimutuel suite)
- `npm run build:server` — clean
- `npm run build` — clean (full client + server)

## Deploy steps (in order — don't skip)

### 1. Run the SQL migration FIRST (before deploying code)

Open Supabase → SQL Editor → paste the contents of `server/db/migrations/005_multi_coin.sql` → Run.

This:
- Creates `supported_coins` table and seeds it with TROLL, USDUC, BUTT
- Adds `coin_mint` column to `markets`, backfills existing rows to TROLL
- Replaces the unique index `markets_one_active_per_schedule` with `markets_one_active_per_coin_schedule`
- Idempotent — safe to run twice if you're not sure

**If you deploy the code without running this migration, the seeder will fail on every tick** because it tries to insert into a column that doesn't exist yet.

### 2. Extract this zip over the repo

From your repo root (e.g. `C:\Users\you\Code\pre-RICHARD-tion.fun`):

Unzip `prerichardtion-fun-v53-multi-coin-patch.zip` and let it overwrite. Every file is a drop-in replacement (no merge needed).

### 3. Verify locally

```
npm install        # nothing new but safe
npm run typecheck  # should be silent
npm test           # 36/36 passing
npm run build      # clean
```

### 4. Commit and push

```
git add -A
git commit -m "v53: parimutuel + multi-coin (TROLL/USDUC/BUTT)"
git push origin main
```

### 5. Render auto-deploys

Watch Render Logs for:
- `[server] escrow-authority publicKey=H1MSe...` (boot)
- `[seed] CREATED coin=TROLL schedule=15m id=...`
- `[seed] CREATED coin=USDUC schedule=15m id=...`
- `[seed] CREATED coin=BUTT schedule=15m id=...`

After 1 cron tick, `GET https://pre-richard-tion-api.onrender.com/api/coins` should return 3 coins.

After ~3 ticks, `GET /api/markets` should return ~9 active markets across the 3 coins.

### 6. Frontend

The frontend (Vercel) doesn't need a separate deploy — `apiClient.ts` is in the same build pipeline and went out with the push. New `listCoins()` method is available; existing screens still work because `listMarkets()` defaults to all coins.

The actual coin-selector tile UI is **v54** (separate ship). After v53, you have:
- 9 active markets (3 per coin) instead of 3
- Solid parimutuel math that always settles solvently
- API ready for the v54 UI

## What v53 does NOT include (planned for v54)

- Tile UI for coin selector with logos + live MC
- Per-coin chart switching
- URL persistence (`?coin=USDUC`)
- "Live MC" card per coin

## Rollback

If anything goes wrong, just `git revert HEAD && git push`. The migration is additive (the new column has a default, the new index doesn't conflict with the old) so the previous deploy will still work even after migration runs.
