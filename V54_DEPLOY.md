# v54.1 — Multi-Coin Tile UI (final, production-ready)

This zip **supersedes v54.0** — same parimutuel + multi-coin foundation, but with the secondary frontend bugs fixed. Use this one and discard the earlier `prerichardtion-fun-v54-tile-ui-patch.zip`.

## What changed since v54.0

**Bug fixes after audit**
- `src/pages/MarketPage.tsx` — the market detail page was hardcoded to `$TROLL`. A USDUC market would have shown "Will $TROLL be over $25M MC..." which is wrong. Now uses `market.symbol` so the title says "Will $USDUC be over $25M MC..." correctly.
- `src/pages/MarketPage.tsx` — Volume / Open Interest stats said `$TROLL` but with v47 SOL-only mode, the underlying value is SOL. Labels now say `SOL`.
- `src/pages/MarketPage.tsx` — position cost basis label same fix (was "$TROLL", now "SOL").
- `src/components/MyPositions.tsx` — total PnL header said "TROLL", now says "SOL".
- `src/components/MyPositions.tsx` — each position row now prefixes with the coin symbol, e.g. `TROLL · 15-minute · target $58M`. Without this you couldn't tell which coin you bet on when multiple were active.

**API resilience improvement**
- `src/hooks/useCoinTicker.ts` — frontend ticker now uses DexScreener's `/token-pairs/v1/solana/{mint}` endpoint as the primary source, with the legacy `/latest/dex/pairs/solana/{pair}` as a fallback. The token-pairs endpoint accepts a mint address (which we always have) instead of a pair address (which requires lookup), so it works universally for any new coin without us needing to know the pair address upfront. This matches the same canonical pair-selection logic the server uses for its own snapshots.

## What's in the patch (full list)

**v53 — Parimutuel rewrite + multi-coin foundation**
- Parimutuel settlement: winners split losers' pool 1:1, 3% fee on winners only, refunds on VOID get full stake (no fee). 16 new tests including the 1v1 NO-winner case that LMSR couldn't settle.
- `supported_coins` registry table + `coin_mint` column on markets
- Per-coin seeder (3 coins × 3 schedules = 9 active markets)
- Per-coin settlement orchestrator (passes the right CoinConfig to settleMarket)
- New `GET /api/coins` route, `?coin=<mint>` filter on `GET /api/markets`
- `apiClient.listCoins()`, `listMarkets({coin})` for the frontend

**v54 — Tile UI**
- `CoinSelector` component (3 horizontal tiles with logo/monogram + symbol + live MC)
- `useCoins` hook (registry fetch, cache)
- `useCoinTicker` hook (per-coin live MC ticker)
- `App.tsx` `ClassicHome` rewired: hero copy, MC card, chart embed, predict panel all switch with the selected coin
- URL persistence: `?coin=USDUC` lands on USDUC, sharing works
- CSS: `.coin-selector` + `.coin-tile` styles, mobile-responsive

**v54.1 — Polish (this version)**
- MarketPage + MyPositions coin-aware label fixes
- useCoinTicker mint-based primary endpoint with pair-URL fallback

## Verified

- `npm run typecheck` — clean
- `npm test` — 36/36 passing
- `npm run build` — clean (full client + server)

## Deploy steps

### 1. Run the SQL migration in Supabase (idempotent — safe to re-run)

Open Supabase → SQL Editor → paste `server/db/migrations/005_multi_coin.sql` → Run.

### 2. Extract this zip over your repo

Drop-in replacements; no merge.

### 3. Verify locally

```
npm install
npm run typecheck
npm test
npm run build
```

### 4. Commit and push

```
git add -A
git commit -m "v53+v54.1: parimutuel + multi-coin tile UI"
git push origin main
```

### 5. Render + Vercel auto-deploy

Watch Render Logs for:
- `[seed] CREATED coin=TROLL schedule=15m id=...`
- `[seed] CREATED coin=USDUC schedule=15m id=...`
- `[seed] CREATED coin=BUTT schedule=15m id=...`

Visit your site:
- 3 tiles below the hero copy
- Click USDUC → page switches: hero copy, MC card, chart, markets all become USDUC
- Click into a USDUC market → detail page says "Will $USDUC be over $25M MC..." (correct)
- Bet, see position appear under the right coin in MyPositions

## Rollback

`git revert HEAD && git push`. Migration is additive.
