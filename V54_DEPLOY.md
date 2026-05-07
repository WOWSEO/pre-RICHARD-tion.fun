# v54 — Multi-Coin Tile UI (full ship)

## What's in this patch

This is **v53 + v54 combined**. If you haven't deployed v53 yet, run the SQL migration first (see step 1 below). If you already shipped v53, skip step 1 — the migration is idempotent so re-running is safe but unnecessary.

**v54 — Tile UI (new in this patch)**
- `src/components/CoinSelector.tsx` — three horizontal tiles, one per registered coin, each showing logo placeholder + symbol + live MC. Active tile glows green. Click switches the entire page (markets, chart, MC card) to that coin.
- `src/hooks/useCoins.ts` — fetches `/api/coins` and caches the registry.
- `src/hooks/useCoinTicker.ts` — generic per-coin live price/MC ticker. Replaces the old hardcoded `useTrollTicker`.
- `src/App.tsx` — rewires `ClassicHome` to drive everything off the selected coin: hero copy, MC card label, market filter, chart embed URL.
- `src/index.css` — adds `.coin-selector` + `.coin-tile` styles (matches existing classic-* visual language).
- URL persistence — `?coin=USDUC` or `?coin=<mint>` lands on that coin. Switching coin updates URL via `replace`.

**v53 — Parimutuel + multi-coin foundation (carried over)**
- `server/db/migrations/005_multi_coin.sql` — supported_coins registry table + coin_mint column on markets
- `src/config/coins.ts` — TROLL + USDUC + BUTT registry
- `server/services/marketSeeder.ts` — seeds 3 coins × 3 schedules = 9 markets
- `server/services/settlementOrchestrator.ts` — settles with the right coin's config
- `server/routes/coins.ts` — `GET /api/coins`
- `server/routes/markets.ts` — `GET /api/markets?coin=<mint>` filter
- Parimutuel rewrite (settlementEngine, tradeEngine, pricingEngine)
- 16 new parimutuel tests including the 1v1 NO-winner case that LMSR couldn't settle
- `server/services/payoutEngine.ts` — fee-on-winners-only gate

## Verified before zip

- `npm run typecheck` — clean
- `npm test` — 36/36 passing
- `npm run build` — clean (full client + server)
- CSS bundle grew ~2KB, JS bundle grew ~3KB for the v54 selector

## Deploy steps

### 1. Run the SQL migration (first deploy only — idempotent if you re-run)

Open Supabase → SQL Editor → paste `server/db/migrations/005_multi_coin.sql` → Run.

This creates `supported_coins`, adds `coin_mint` to `markets`, replaces the unique index, and seeds TROLL + USDUC + BUTT.

### 2. Extract this zip over your repo

Unzip `prerichardtion-fun-v54-tile-ui-patch.zip` and let it overwrite. Drop-in replacements; no merge.

### 3. Verify locally

```
npm install
npm run typecheck
npm test
npm run build
```

All green expected.

### 4. Commit and push

```
git add -A
git commit -m "v53+v54: parimutuel + multi-coin tile UI (TROLL/USDUC/BUTT)"
git push origin main
```

### 5. Render auto-deploys

Watch Render Logs:
- `[server] escrow-authority publicKey=H1MSe...` (boot)
- `[seed] CREATED coin=TROLL schedule=15m id=...`
- `[seed] CREATED coin=USDUC schedule=15m id=...`
- `[seed] CREATED coin=BUTT schedule=15m id=...`

After 1–3 ticks: `GET /api/coins` returns 3 coins. `GET /api/markets` returns ~9 active.

### 6. Vercel auto-deploys frontend on push

Visit your site:
- 3 tiles below the hero copy, one per coin
- Click USDUC tile → entire page switches to USDUC: hero copy says "$USDUC", MC card shows USDUC's MC, chart switches to USDUC, the 3 schedule slots show USDUC markets
- Refresh the page — `?coin=USDUC` is in URL, page lands on USDUC
- Share the URL — recipient lands on the same coin

## Known limitations / planned for later

- **No coin logos yet.** Each tile shows a 2-letter monogram with a deterministic color (TROLL = greenish, USDUC = bluish, BUTT = different hue). To add real logos, drop image URLs into `supported_coins.image_url` via SQL — the tile component already supports `<img>` with monogram fallback.
- **Mobile layout.** Below 720px the tiles stack 2-wide; below 460px they stack 1-per-row. The hero copy + chart layout from existing CSS still applies.
- **No per-coin volume aggregation in tiles.** Each tile only shows live MC. Volume across that coin's markets isn't summed (yet) — the schedule slot buttons still show per-market volume.

## Rollback

`git revert HEAD && git push`. Migration is additive. The previous deploy's frontend (single-coin) doesn't know about the registry but still works because `/api/markets` (no filter) returns all coins' markets — including legacy clients seeing 9 instead of 3 markets, which is harmless visual noise.
