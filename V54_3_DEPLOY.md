# v54.3 — Wording cleanup pass

Drop-in patch on top of v54.2 (logos). Eight files changed, all wording or
small UX adjustments to match the SOL-only / multi-coin reality. Zero schema
changes. Zero engine changes. 36/36 tests still pass.

## What user-facing changes

### Coin-aware (instead of hardcoded $TROLL)

- **MarketCard question** (`src/components/MarketCard.tsx`)
  Before: "Will $TROLL be over $X MC at 7PM?"
  After: "Will $USDUC be over $X MC at 7PM?" (or $TROLL / $BUTT, depending
  on which coin the market is for). Uses `market.symbol` from the wire format.

- **Legal/About copy** (`src/components/Legal.tsx`)
  Before: "for $TROLL holders. Bet SOL on whether the $TROLL market cap…"
  After: "for memecoin holders. Bet SOL on whether a supported coin's
  market cap…" — covers TROLL/USDUC/BUTT and any future coin.

- **AdminPage MC seeder description** (`src/pages/AdminPage.tsx`)
  Before: "snapshots live $TROLL MC at insert time"
  After: "snapshots the coin's live MC at insert time" — accurate for the
  v53 multi-coin seeder.

### SOL units (instead of legacy $TROLL units)

These were $TROLL labels on values that are actually SOL (since v47
SOL-only). Schema column names like `cost_basis_troll` and `amount_troll`
are unchanged — only the displayed labels.

- **App.tsx `formatVolumeTroll`** — outputs "1.8 SOL" / "0.42 SOL" /
  "0 SOL" instead of "1.8M $TROLL". Function name kept (legacy). Used by
  the per-market option buttons in ClassicHome.

- **PredictPanel** (used by `/market/:marketId`)
  - Amount label: "Amount $TROLL" → "Amount SOL"
  - Input unit suffix: "$TROLL" → "SOL"
  - Insufficient-balance message: "X $TROLL — top up" → "X SOL — top up"
  - Footer disclaimer: "Real $TROLL · Tokens transfer to escrow" →
    "Real SOL · SOL transfers to escrow"
  - **The "No $TROLL detected · Add $TROLL to your wallet" prompt was
    removed entirely.** It checked the SPL TROLL balance and asked the
    user to add TROLL even though bets are SOL. Insufficient-SOL is still
    caught by the existing balance check at submit time.

- **ClaimablePayouts** — payout unit suffix "$TROLL" → "SOL"

- **AdminPage** — "Confirmed deposits / Pending withdrawals X $TROLL" →
  "X SOL". Per-row deposit and withdrawal listings same.

- **ClaimsPage** — "Your $TROLL claims" → "Your SOL claims".
  "Confirmed = $TROLL is in your wallet" → "Confirmed = SOL is in your
  wallet".

- **MyPositions JSDoc** — comment said the UI converted SOL bets to
  TROLL-equivalent at entry time (v23 currencyConverter). That stopped
  being true in v47 SOL-only. Updated to reflect that values are SOL and
  the column name is just legacy.

## What was intentionally NOT changed

- `src/pages/HomePage.tsx` — unrouted (App.tsx routes `/` to ClassicHome,
  not HomePage). Dead file. Could delete in a separate refactor.
- `src/pages/TrollPage.tsx` — TROLL-specific archive page, kept as-is per
  scope. It's at `/troll`.
- `src/components/TrollChart.tsx`, `TrollBalancePill.tsx`,
  `WalletBalancesPill.tsx`, `CoinOfDayModal.tsx`, `FloatingHeroCards.tsx`
  — TROLL-specific by design (TROLL chart embed, TROLL SPL balance pill,
  TROLL hero card). Used by `/troll` and the wallet UI.
- All function names (`formatVolumeTroll`, `formatTrollBalance`,
  `useTrollBalance`, etc.) — renamed would touch every call site. Kept.
- All env var names (`VITE_TROLL_MINT`) — config keys, not user-visible.
- All DB column names (`amount_troll`, `cost_basis_troll`,
  `escrowConfirmedTotal`) — would require a migration. Values inside are
  SOL units; only the labels were wrong.
- All test fixtures — they reference `$TROLL` as test data, not
  user-facing. 36/36 tests still pass.
- Dead code branches in App.tsx for `currency !== "sol"` (currency is
  hardcoded to "sol"). Left for now — removing would be a refactor.

## Verified before zip

- `npm run typecheck` → clean (client + server, both pass)
- `npm test` → 36/36 passing
- `npm run build` → clean (5330 modules, full Vite client build)
- `npm run build:server` → clean

## Deploy

### 1. Unzip over your repo

Eight drop-in file replacements. No merges. No new files.

### 2. Verify locally (optional but quick)

```
npm run typecheck
npm test
npm run build
```

All green expected.

### 3. Commit and push

```
git add src/App.tsx src/components/PredictPanel.tsx src/components/MarketCard.tsx src/components/ClaimablePayouts.tsx src/components/Legal.tsx src/components/MyPositions.tsx src/pages/AdminPage.tsx src/pages/ClaimsPage.tsx
git commit -m "v54.3: wording cleanup — TROLL→SOL on SOL-denominated values, coin-aware market questions"
git push origin main
```

### 4. Vercel auto-deploys

No backend changes, no migration. Render does not need to redeploy.

### 5. Smoke test

- Visit pre-richard-tion.fun → ClassicHome volume labels show "X SOL"
  instead of "X $TROLL" on the per-market option buttons
- Click into a market detail (`/market/<id>`) → predict panel shows
  "Amount SOL", "SOL" suffix, no "Add $TROLL" prompt
- Switch to USDUC tile → market questions in the predict panel options
  read "Will $USDUC be over…" not "Will $TROLL be over…"
- `/admin` → "Confirmed deposits X SOL" instead of "X $TROLL"
- `/claims` → "Your SOL claims"

## Rollback

`git revert HEAD && git push`. No database state to undo. No coordination
with Render needed.
