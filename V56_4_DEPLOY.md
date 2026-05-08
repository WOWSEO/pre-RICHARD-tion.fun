# v56.4 — Fix the trollBalance check that was bouncing every bet

## The bug

Every bet placed since v47 (the SOL-only switch) has been failing in `/enter`. Not visibly — the SOL transfer to escrow succeeded, so wallets did show the deduction. But the in-memory brain rejected the position-creation step with this error:

```
buyYES: wallet 7KwQ... balance 0 < 0.01
```

That's the brain's `trollBalance` check. The check is a v52 LMSR-era artifact: the brain expected to track each user's TROLL token balance in memory, deducting from it on each buy. In v47 we switched to SOL-only and verified deposits on-chain instead — but nobody updated `/enter` to stop passing `trollBalance: 0` to the brain.

The brain saw 0 < amount, threw, and v54.6's outer catch then queued a refund. So:

1. User clicks Predict YES, signs, broadcasts → SOL lands in escrow ✓
2. Brain bounces the position with the trollBalance error ✗
3. v54.6 catch fires: marks deposit failed, queues refund ✓
4. Refund attempts to send back, fails because escrow has no fee headroom ✗
5. User's SOL stuck in escrow indefinitely

This is why MyPositions has been empty all session. Not a UI bug. There were no positions to display because no bet ever made it past step 2.

## The fix

`server/routes/markets.ts`, line 335. Pass `Number.MAX_SAFE_INTEGER` instead of `0`:

```js
const ensureUser = { wallet, trollBalance: Number.MAX_SAFE_INTEGER };
```

The brain's balance check is now bypassed. The brain still does its work (creates the position, updates the pool, records the trade), but the artifact balance check passes trivially. No refactor of the User type — that would propagate through tests and audit tooling.

`/exit` and the settlement orchestrator also pass `trollBalance: 0` to the brain, but neither hits the balance check (`sell()` doesn't check, settlement uses `resolve` and `applyPayouts` which also don't check). So only this one line needed fixing.

## File

- `server/routes/markets.ts` — one-line change

## Verified

- typecheck ✓
- 48/48 tests ✓
- server build ✓

## Deploy

```
unzip the patch
git add server/routes/markets.ts
git commit -m "v56.4: bypass v52 trollBalance check in /enter — fixes every-bet-fails bug"
git push origin main
```

## After deploy: also fund the escrow

The other thing you found — the escrow being short on lamports for the refund tx fee — is a separate but real issue. Send 0.05 SOL from any wallet to the escrow:

```
H1MSeVqfA1nBrh7rsCJdjHJxeLoVPL32iS3Bbt5UYXEb
```

Then the queued refunds for deposits 37 and 38 will retry on the next payouts cron tick (~60 seconds) and land in your wallet.

## What this means for everything else this session

- All the "internal_error" failures: this bug
- All the markets settling with `no_opposition`: this bug (the bets that were supposed to be on opposite sides never made it to position-creation)
- The "double-spend" concern in v56.3: not actually possible to begin with, because no bets were succeeding. v56.3 is still the right defensive code, but the actual exposure was zero.
- All the stuck deposits: this bug

After v56.4 deploys, your next bet should ACTUALLY create a position, ACTUALLY appear in MyPositions (now in the predict overlay column from v56.3), and ACTUALLY settle with a real outcome if both sides have bets.

## Stack to push

If you haven't pushed v56.3 yet, push v56.3 + v56.4 together. They're in different files and don't conflict:

- v56.3: src/App.tsx, src/index.css, server/routes/markets.ts (different lines)
- v56.4: server/routes/markets.ts (the trollBalance line)

Push both, refresh, place a bet from one wallet, place opposite-side bet from your second wallet, watch a market actually settle with a real winner for the first time.
