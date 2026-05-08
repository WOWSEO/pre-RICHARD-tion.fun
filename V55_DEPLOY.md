# v55 — Quote-poll tightening + wallet-signed exits

Two fixes. Both production-ready, both required before opening to real users.

## Fix 1: quote-poll spam (UX)

Your console screenshot showed dozens of `[entry/quote] requesting market=BUTT-daily-44` calls firing in succession. Cause: parent state ticking on the live timer caused the quote `useEffect` to re-fire even when (selected, side, amount) hadn't actually changed. The 250ms `setTimeout` was being created and torn down on every parent render but the underlying request key was identical.

Fix: introduced a `lastQuoteKeyRef` that tracks the last `(marketId, side, amount)` triple. The effect now skips early if the key matches what's already in flight or resolved. Bumped the debounce window from 250ms to 400ms so faster typers get a single quote when they finish, not three intermediate ones.

Net effect: the console calms down by 10x or more. No functional change.

## Fix 2: wallet-signed exits (security)

The `/api/positions/:id/exit` endpoint previously validated ownership by checking `pos.wallet === request.body.wallet`. That check was trivially bypassed: an attacker who learned a position UUID and the wallet that owned it could force-exit the bet with a request like:

```
POST /api/positions/<uuid>/exit
{"wallet": "<victim_wallet>"}
```

Money still went back to the victim's wallet (the exit destination is taken from the position row, not the request). But the attacker could grief: force-close someone's bet at the 3% exit fee against their will, denying them potential upside.

v55 closes this. Caller must now sign a canonical message:

```
prerichardtion.fun — exit position intent

wallet:    <wallet>
position:  <position-id>
shares:    ALL
timestamp: <iso>

By signing, I confirm I want to exit this position.
Exits cannot be undone and incur a 3% fee.
```

Server rebuilds the message from request fields, verifies the ed25519 signature (`@noble/curves/ed25519`) against the wallet's pubkey, rejects if signature is missing, malformed, signed by the wrong wallet, or older than 5 minutes. Without these, returns 401.

Frontend changes: `MyPositions.onExit` and `MarketPage.onExit` both now use `signExitIntent()` from `walletMessage.ts` to prompt the user's wallet (Phantom/Solflare popup) before posting. The user-visible flow is one extra signature prompt per exit. No SOL leaves the wallet for the signing step.

Cancel-handling: the user clicking "Cancel" in the wallet popup surfaces "You cancelled the signature" instead of an opaque error.

## Files

- `src/App.tsx` — quote-poll key-comparison + 400ms debounce
- `src/services/walletMessage.ts` — `buildExitMessage`, `signExitIntent`
- `src/services/apiClient.ts` — `api.exit` accepts `signature` and `timestamp`
- `src/components/MyPositions.tsx` — uses `useWallet()`, signs before exit
- `src/pages/MarketPage.tsx` — same
- `server/util/walletSignature.ts` — NEW, ed25519 verifier
- `server/routes/positions.ts` — requires signature, rejects unsigned/stale/wrong-wallet

## Verified

- `npm run typecheck` — clean
- `npm test` — 45/45 passing
- `npm run build` — clean
- `npm run build:server` — clean

## Deploy

No SQL migration needed.

```
unzip the patch over the repo
git add -A
git commit -m "v55: quote-poll dedup + wallet-signed exits"
git push origin main
```

This stacks on top of v54.3-v54.7. If you push them all together, your single commit message can be:

`v54.3-v55: wording, exits, hero, per-coin thresholds, auto-refund, HANTA, quote-dedup, signed-exits`

## Smoke test after deploy

1. Open a position, hit Exit. Phantom should pop up showing the exit intent message (wallet, position, ALL, timestamp). Approve. Position exits.
2. Hit Exit again, click Cancel in Phantom. UI shows "You cancelled the signature."
3. Try to forge a request via curl with no signature: should get 401 `missing_signature`.
4. Try to replay an old signature (5+ minutes old): should get 401 `signature_expired`.

## Known scope cuts (deferred to v56)

- Audit-receipt link surfaced from settled positions in MyPositions (the `/audit/:id` route still works, just no UI link yet)
- Coin add-tool (paste a mint, generate config + SQL)
- Cron health endpoint with last-tick timestamps
- Mobile responsive review of the predict panel

These are valuable but not security-critical. v55 ships the security fix without bundling other changes that need their own QA.
