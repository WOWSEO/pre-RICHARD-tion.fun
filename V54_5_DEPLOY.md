# v54.5 — Hero copy + per-coin source-disagreement threshold

Two surgical changes on top of v54.4. Six file replacements.

## What user-visible changes

### Hero copy

Big "Prediction" word stays clamp(54px, 7vw, 96px). Below it, on its own
line, "markets for Pump.Fun coins." in a smaller font (~24px). Static
across coin selection — the eyebrow above and predict panel on the right
already convey which coin is active, so the h1 doesn't need to shift.

Old: `Prediction markets for $TROLL holders.` (all big, coin-aware)
New:
```
Prediction          ← big, unchanged
markets for         ← small, static
Pump.Fun coins.
```

### Per-coin sourceDisagreementThreshold

Settlement now reads the threshold from `CoinConfig` first, falling back
to the engine default of 2.5%. Production values:

| Coin  | Liquidity | Threshold | Why |
| ----- | --------- | --------- | --- |
| TROLL | $2.5M     | 2.5% (default) | Tight prices, default works |
| USDUC | $908K     | 5%        | Moderate liquidity |
| BUTT  | $13K      | **15%**   | Day-3 finding: every 4/4 closed BUTT 15m markets voided with `source_disagreement` because DexScreener and GeckoTerminal disagree by way more than 2.5% on a $13K-liquidity coin |

Without this fix, BUTT would void on every settlement attempt the moment
two-sided participation happened. Now BUTT settles cleanly up to 15%
disagreement and only voids when the sources are genuinely far apart.

Resolution precedence: `options.sourceDisagreementThreshold` (explicit
test override) → `coin.sourceDisagreementThreshold` (per-coin) → `0.025`
(engine default).

## Files changed

- `src/App.tsx` — h1 split into "Prediction" + tagline span
- `src/index.css` — `.classic-h1-tagline` style
- `src/market/marketTypes.ts` — `CoinConfig.sourceDisagreementThreshold?` field
- `src/market/settlementEngine.ts` — threshold precedence chain
- `src/config/coins.ts` — USDUC=0.05, BUTT=0.15, TROLL omits (default)
- `src/tests/auditReceipt.test.ts` — 2 new tests covering the per-coin override (settles at 6.4% under BUTT 15% threshold; voids at 25% even with BUTT's loose threshold)

## Verified

- `npm run typecheck` — clean (client + server)
- `npm test` — 45/45 passing (was 43, added 2 new tests for the threshold override)
- `npm run build` — clean
- `npm run build:server` — clean

## Deploy

```
git add src/App.tsx src/index.css src/market/marketTypes.ts src/market/settlementEngine.ts src/config/coins.ts src/tests/auditReceipt.test.ts
git commit -m "v54.5: hero copy + per-coin source_disagreement threshold"
git push origin main
```

Vercel auto-deploys frontend. Render auto-deploys API. No DB migration. No env vars.

## What's NOT in v54.5 (deferred to v54.6)

The auto-recovery for stuck-pending deposits and the /enter try/finally
hardening. Those need more careful design (max age cutoff, idempotency
guards, what counts as "stuck") and I want a clean separate patch for
them so we can roll back independently if needed.

## TROLL 15m market still stuck (unrelated)

This patch does not unstick the TROLL 15m. That's still waiting on the
`POST /api/admin/seed-markets` response so we can see why the seeder
isn't replacing TROLL-15m-75. Run that with the real admin key and paste
the JSON.

## Rollback

`git revert HEAD && git push`. No DB state to undo. Existing settled
markets keep their outcomes.
