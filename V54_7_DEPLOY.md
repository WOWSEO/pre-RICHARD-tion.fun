# v54.7 — HANTA becomes the default coin, gets its logo

Three files. Drop-in. Two lines of code change in `coins.ts` plus a SQL migration plus the logo file.

## What changes

- HANTA tile appears first (leftmost) in the coin selector
- Visiting `pre-richard-tion.fun` with no `?coin=` URL param lands you on HANTA's market by default
- HANTA tile shows the virus photo logo instead of the H monogram fallback

The order is now: **HANTA → TROLL → USDUC → BUTT** (left to right).

## Files

- `public/logos/hanta.jpg` — your uploaded virus photo (was misnamed `.png` but is JPEG bytes; renamed for correct Content-Type)
- `src/config/coins.ts` — `COINS` array reordered to `[HANTA, TROLL, USDUC, BUTT]`, `DEFAULT_COIN` switched from TROLL to HANTA
- `server/db/migrations/007_hanta_default.sql` — sets HANTA's `display_order = 1`, others shift to 2/3/4, and points `image_url = '/logos/hanta.jpg'`

## Deploy

### 1. Run the SQL migration in Supabase

Open Supabase SQL Editor → paste `server/db/migrations/007_hanta_default.sql` → Run. The final `select` should show:

```
display_order  symbol  name         image_url
1              HANTA   Hantavirus   /logos/hanta.jpg
2              TROLL   Troll Cat    /logos/troll.jpg
3              USDUC   Unstable Coin /logos/usduc.jpg
4              BUTT    Buttcoin     /logos/buttcoin.webp
```

### 2. Unzip over the repo, push

```
git add public/logos/hanta.jpg src/config/coins.ts server/db/migrations/007_hanta_default.sql
git commit -m "v54.7: HANTA default coin + logo"
git push origin main
```

Vercel auto-deploys frontend (Vite picks up the new public/ file). Render auto-deploys backend.

### 3. Smoke test

Hit `pre-richard-tion.fun` with no URL params. The page should land on HANTA, with the virus photo as the leftmost tile.

If it still lands on TROLL, hard-refresh (Ctrl+F5). The order is loaded from `/api/coins` which itself caches per browser session, so the first request after deploy might still be cached.

## Rollback

```sql
update supported_coins set display_order = 1 where mint = '5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2';
update supported_coins set display_order = 4 where mint = '2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y';
```

Plus `git revert HEAD && git push` for the code side.

## Stack of pending deploys

If you haven't pushed v54.3 / v54.4 / v54.5 / v54.6 yet, this would be the fifth on top. They don't conflict. Suggested final commit message if doing them as one push:

`v54.3-v54.7: wording cleanup, exits, hero copy, per-coin thresholds, auto-refund, HANTA default`
