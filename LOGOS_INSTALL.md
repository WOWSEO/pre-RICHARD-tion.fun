# Logo pack — TROLL / USDUC / BUTT

Drop-in for the v54 `CoinSelector` tiles. Replaces the 2-letter monogram
fallbacks (TR / US / BU) with the real coin logos.

No code changes. The `<img src={coin.imageUrl}>` path in
`src/components/CoinSelector.tsx → CoinLogo` already works — `image_url` is
just `null` on every `supported_coins` row right now, so the component falls
back to monograms.

## Files in this pack

```
public/logos/troll.jpg     86x86  JPEG  troll-face meme
public/logos/usduc.jpg     86x86  JPEG  Unstable Coin
public/logos/buttcoin.webp 400x400 WebP Buttcoin
```

The two PNGs you uploaded were actually JPEG bytes with a `.png` extension —
renamed to `.jpg` so Vercel serves them with the correct `Content-Type`.

## Install

### 1. Drop files into the frontend repo

Unzip over your repo root. The three files land at:

```
public/logos/troll.jpg
public/logos/usduc.jpg
public/logos/buttcoin.webp
```

Vite copies everything under `public/` to the build output unchanged, so
after deploy these are served at `https://pre-richard-tion.fun/logos/...`.

### 2. Run the SQL update in Supabase

Open Supabase → SQL Editor → New query → paste → Run:

```sql
update supported_coins set image_url = '/logos/troll.jpg'
 where mint = '5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2';

update supported_coins set image_url = '/logos/usduc.jpg'
 where mint = 'CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump';

update supported_coins set image_url = '/logos/buttcoin.webp'
 where mint = 'Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump';
```

Expected result: "no rows returned" (these are UPDATEs, not SELECTs — the
Supabase UI shows that on success). Then verify:

```sql
select symbol, image_url from supported_coins order by display_order;
```

Should show all 3 with non-null image_url.

### 3. Commit and push

```
git add public/logos/
git commit -m "v54.2: add TROLL / USDUC / BUTT logos"
git push origin main
```

Vercel auto-deploys.

### 4. Verify

Hit `https://pre-richard-tion-api.onrender.com/api/coins` — each coin object
should now have `imageUrl: "/logos/<file>"` instead of `null`.

Refresh `https://pre-richard-tion.fun` — the three monograms should be
replaced with the real logos in all three tiles.

## Why image_url is a relative path

The `<img>` tag renders inside the frontend (Vercel domain). A relative
path like `/logos/troll.jpg` resolves against the page origin, so the
browser fetches it from Vercel, not Render. Render never serves these
files; it just hands the path through the JSON API.

If you ever move the logos to a CDN, swap the values to absolute URLs
(`https://cdn.example.com/troll.jpg`) and that's the only change — the
component is already URL-agnostic.

## Rollback

```sql
update supported_coins set image_url = null;
```

Tiles fall back to monograms again. `git revert` is optional — the static
files in `public/logos/` are inert without the DB pointing at them.
