# v54.4 — Exit feature + TROLL pill removal

Drop-in patch on top of v54.3. Six file replacements. Adds a real
parimutuel exit-at-cost-basis feature (sells now work) and removes the
TROLL holdings pill from the connected-wallet header.

## What user-facing changes

### Exit feature (sells now work)

Each open position in MyPositions gets an **Exit** button. Clicking it:

1. Confirms with a browser dialog showing gross stake and net refund (after 3% fee)
2. Calls `POST /api/positions/:id/exit` (the endpoint already existed since v42, but the brain's `sell()` threw because parimutuel blocked exits)
3. Decreases the relevant pool by the user's proportional cost basis
4. Marks the position `closed` (full exit) or reduces `shares`/`costBasisTroll` (partial exit)
5. Queues an `escrow_withdrawal` row with `reason='exit'`
6. The payout cron processes it: 3% fee to platform fee wallet, 97% to user's wallet

The 3% exit fee uses the same `feeApplies = reason === 'payout' || 'exit'` gate that's been in payoutEngine.ts since v52. No payoutEngine changes needed.

### Settlement: drained-pool void guard

With exits enabled, it's now possible for everyone on a side to exit before close. If the winning side has zero stake at settle, the original parimutuel math (`stake / winnerPool * totalPool`) would either divide by zero or leave loser stakes orphaned in escrow with no winners to pay.

The settlement engine now detects this (`outcome.outcome === "YES" && yesPool === 0`, same for NO) and forces a VOID with reason `no_winners_after_exits`. Loser stakes get refunded.

### TROLL pill removed from wallet header

`WalletBalancesPill` now renders only the SOL chip. The TROLL chip was clutter that suggested you could bet TROLL even though the platform's been SOL-only since v47. The standalone `TrollBalancePill` component is untouched (it's still used on `/troll`).

## What's in the patch (6 files)

- `src/market/tradeEngine.ts` — replaced the throw-on-sell with parimutuel exit-at-cost-basis logic (~100 lines)
- `src/market/settlementEngine.ts` — added the drained-pool void guard (~25 lines inside `applyPayouts`)
- `src/components/MyPositions.tsx` — Exit button + per-position busy/error state, calls `api.exit()`
- `src/components/WalletBalancesPill.tsx` — SOL only, TROLL pill gone
- `src/index.css` — `.my-position-exit` button styles + `.my-position-exit-error` banner
- `src/tests/parimutuel.test.ts` — replaced obsolete "sells throw" test with 7 new tests covering exits + the void guard

## Verified

- `npm run typecheck` — clean (client + server)
- `npm test` — 43/43 passing (was 36, added 7 for the exit feature)
- `npm run build` — clean
- `npm run build:server` — clean

## Deploy

### 1. Unzip over your repo

Six drop-in file replacements. No new files. No migration. No env vars.

### 2. Verify locally

```
npm run typecheck
npm test
npm run build
```

All green expected.

### 3. Commit and push

```
git add src/market/tradeEngine.ts src/market/settlementEngine.ts src/components/MyPositions.tsx src/components/WalletBalancesPill.tsx src/index.css src/tests/parimutuel.test.ts
git commit -m "v54.4: parimutuel exit-at-cost-basis + drop TROLL pill"
git push origin main
```

Render auto-deploys the backend. Vercel auto-deploys the frontend.

### 4. Smoke test once deployed

Place a 0.01 SOL bet on a market with plenty of time on the clock (hourly or daily, not 15-min about to close). Then:

1. Refresh MyPositions to confirm the YES/NO position appears
2. Click **Exit** on that position
3. Confirm the dialog (you'll see "You receive: 0.0097 SOL")
4. Watch for the row to disappear (or shares decrease for partial exits)
5. Check Phantom in 30-60s for the 0.0097 SOL refund

## TROLL 15-min market closed when others aren't (NOT FIXED — needs your input)

I read the seeder: the only way the 15m can be stuck closed while others are open is if a previous 15m got stuck in `status='settling'` and the unique index `markets_one_active_per_coin_schedule` blocks the new one from inserting. To diagnose, paste the last 20 lines of the `tick-markets` cron output (Render → Logs → filter for `[seed]` or `[settle]`). Specifically look for:

- `[seed] noop coin=TROLL schedule=15m existing=mkt_xyz status=settling` — confirms the stuck-settling theory
- `[settle] failed market=mkt_xyz reason=...` — explains why it's stuck

Quick recovery if the stuck-settling theory is right: hit `POST /api/admin/tick-markets` to force the lifecycle to advance, or manually update the row in Supabase (`update markets set status = 'settled' where id = 'mkt_xyz'`) and let the next cron tick re-seed.

## Rollback

`git revert HEAD && git push`. No database state to undo. Existing closed positions don't roll back (they're permanent records of trades). The only thing that goes away is the Exit button.

## Known followups for v55+

- 3% exit fee is debatable. If you want fee-free exits as a "free undo button", change `payoutEngine.ts` line ~138 to `feeApplies = reason === 'payout'`.
- Browser `confirm()` dialog is the v1 UX. Consider a proper modal with side preview, fee breakdown, and "are you sure" wording.
- Position signing: the exit endpoint trusts `wallet` in the request body. Anyone who knows your position UUID could trigger an exit. UUIDs aren't guessable but should require a wallet signature for v55.
