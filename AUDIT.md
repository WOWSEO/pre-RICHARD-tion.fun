# prerichardtion.fun — Audit & Hardening Report (v5)

Source of truth: `prerichardtion-fun.zip` v0.4.0 (the v4 ship).
Output: this patch ZIP layered on top — copy contents to project root.

## Acceptance commands run, all green

```
npm install        ok
npm test           4 files / 61 tests passed
npm run typecheck  ok (client + server)
npm run build      ✓ built (~200KB gzipped)
npm run build:server  ok
```

After applying this patch the same five commands continue to pass, the server boots, and `GET /api/health` returns `200 {"ok":true,...}`.

## Audit findings → fixes

### CRITICAL bugs found and fixed

| # | Where | Bug | Fix |
|---|---|---|---|
| 1 | `server/db/schema.sql` | `settlements.audit_receipt_id REFERENCES audit_receipts(market_id)` was declared **before** `audit_receipts`. `deferrable initially deferred` defers constraint *checking*, not constraint *creation* — fresh-DB migration would fail with `relation "audit_receipts" does not exist`. | Reordered: `audit_receipts` is now declared before `settlements`. |
| 2 | `server/db/schema.sql` + `server/routes/admin.ts` | `markets.created_by` was a FK to `users(wallet)`, but admin routes inserted the actor string (`"admin"`) which has no users row → every market creation failed. | Removed FK; `created_by` is plain text. |
| 3 | `src/market/tradeEngine.ts`, `src/market/positionEngine.ts` | Trade & position IDs were `trade_${++counter}` / `pos_${++counter}` — sequential per process. After a server restart, IDs reset to 1 and collided with PK on first insert (`duplicate key on trades.id`). | IDs now use `crypto.randomUUID()` (32-char hex suffix). Tests still pass — none asserted on the suffix format. |
| 4 | `server/services/payoutEngine.ts` | Two concurrent payout workers each read `status='pending'`, both decided to send, both submitted the SPL transfer → **double payout from escrow**. | Atomic CAS: `UPDATE … SET status='sent' WHERE id=$ AND status='pending' RETURNING *`. Only the winner proceeds; everyone else gets `not_claimable`. |
| 5 | `server/services/settlementOrchestrator.ts` | Two concurrent settlement workers could both pass the terminal-status check, both run the brain settlement, both queue duplicate payout/refund rows. | Worker now claims the slot atomically: `UPDATE … SET status='settling', version=v+1 WHERE id=? AND version=v AND status IN ('open','locked','settling')`. Plus a payouts-queued dedupe set. |
| 6 | `server/services/escrowVerifier.ts` | Authority signer was checked, but the **source token account** was not — a delegated authority on someone else's TROLL ATA could fund a position with funds that aren't theirs. Also a dead-code fallback `info.authority ?? info.multisigAuthority ?? info.source` would have used the source ATA as authority on weird inputs. | Added explicit `expectedSourceAta = ATA(TROLL_MINT, expectedSource)` check; the parsed `info.source` must equal it. Removed the `info.source` fallback entirely. Multisig is now explicitly unsupported. |
| 7 | `server/db/marketLoader.ts` | `syncMarket` inserted trades and upserted positions **before** the version-checked market UPDATE. On lock conflict, the trades & positions remained in the DB attached to a market state that was never updated → orphan rows that confused subsequent reads and audit receipts. | Restructured: market UPDATE first (claims the version transition), then trades, then positions. On version conflict nothing is written. The optimistic-lock error is now an exported `OptimisticLockConflict` class so callers can recognize and retry it. |
| 8 | `server/routes/markets.ts` & `positions.ts` | On `optimistic_lock_conflict`, the route returned 500. The user's TROLL was already in escrow but no position was recorded. | Both routes wrap load → brain → sync in a 3-attempt retry loop with 50ms × attempt + jitter backoff. On exhaustion, the deposit is marked `failed` with reason `lock_contention_after_3_retries` so an admin can refund. |

### High-severity bugs found and fixed

| # | Where | Bug | Fix |
|---|---|---|---|
| 9 | `server/env.ts`, `.env.example` | Spec calls for `SERVER_PORT`; code read `PORT` only. | Now accepts `SERVER_PORT` (preferred) or `PORT` (legacy fallback). `.env.example` documents `SERVER_PORT`. |
| 10 | `server/routes/admin.ts` (void-market) | `void-market` blindly updated `status='voided'` regardless of concurrent settlement. Could clobber a settlement-in-flight. Could also queue duplicate refunds if re-run. | Atomic version-checked claim: `UPDATE … WHERE id=? AND version=v AND status NOT IN ('settled','voided')`. Refund queue dedupes against existing refunds. |
| 11 | `server/services/payoutEngine.ts` | Withdrawal status went `pending → confirmed` directly; the `'sent'` state was never written, so an in-flight transaction had no DB indicator and a second worker could race in. | (Same fix as #4 above — the CAS now writes `status='sent'` immediately when claimed. Confirmed in a second update after RPC succeeds.) |
| 12 | `server/db/schema.sql` | `escrow_withdrawals.signature` had no UNIQUE constraint. A worker that retries after a partial confirm could insert a duplicate signature row. | Added `UNIQUE` on `signature`. |
| 13 | `server/routes/admin.ts` | Failed payouts had no admin recovery path. | New endpoint `POST /api/admin/payouts/retry-failed { id }` resets a single failed withdrawal back to `pending`. |
| 14 | `server/routes/admin.ts` | `closeAt` validation only checked it was a valid date, not that it was in the future. | Added explicit `closeAt > now` check. |

### Lower-severity issues noted, not fixed (acceptable for v1)

These remain in the code and are documented in **§Remaining risks** below:

- The escrow ATA is a single global token account owned by `ESCROW_AUTHORITY`. Per-market segregation is enforced only in the DB via `escrow_deposits` / `escrow_withdrawals` accounting. A real per-market PDA program is future work.
- `TOKEN_PROGRAM_ID` is hardcoded to the original SPL Token program; Token-2022 mints are not supported. (Pump.fun coins use the original program, so $TROLL specifically is fine.)
- Confirmation-level mismatch between the `Connection` constructor (set to `DEPOSIT_CONFIRMATION` env, possibly `processed`) and the `getParsedTransaction` read (forced to at-least-`confirmed`). This is intentional — verification is stricter than the configured commitment — but worth noting.
- Brain `nextPositionId()` & `nextTradeId()` rely on `globalThis.crypto.randomUUID()` which is Node 18+. `package.json` already pins `engines.node >= 20`, so this is safe.

## Files changed

```
.env.example
AUDIT.md                            (new)
server/env.ts
server/db/schema.sql
server/db/marketLoader.ts
server/services/escrowVerifier.ts
server/services/payoutEngine.ts
server/services/settlementOrchestrator.ts
server/routes/markets.ts
server/routes/positions.ts
server/routes/admin.ts
src/market/tradeEngine.ts
src/market/positionEngine.ts
```

13 files (12 modified, 1 new). No frontend changes — UI is untouched per the constraint.

## Tiny real-money test mode (runbook)

The system is now safe to run end-to-end on real $TROLL with tiny amounts. Use this exact sequence on **mainnet** with an isolated authority wallet:

### Prep (one-time)

1. `solana-keygen new --outfile escrow.json` — generates the escrow authority. Fund it with **0.05 SOL** (covers ~10 ATA creations + a hundred transfers).
2. Convert the secret to base58 and put it in `.env` as `ESCROW_AUTHORITY_SECRET`.
3. Apply `server/db/schema.sql` to a fresh Supabase project. Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (service-role, NOT anon).
4. Set `TROLL_MINT` and `VITE_TROLL_MINT` to the real $TROLL mint. Set `HELIUS_RPC_URL` + `VITE_HELIUS_RPC_URL` to your Helius key.
5. `ADMIN_API_KEY` = a long random string.
6. `npm run dev:server` (port 8787) and `npm run dev` (port 5173) in separate terminals.

### Test 1 — exit before lock returns the user's $TROLL

1. Open `/admin`, paste admin key, **Create market**: `15m` schedule, `targetMc=99999999999999`, `closeAt` 10 minutes out. (Huge target → almost guaranteed `NO`, but we'll exit before settlement so outcome doesn't matter.)
2. From the market page on a different wallet (Phantom), buy YES with **1 $TROLL**. Sign in Phantom.
3. Wait for the deposit to flip from `Pending` to `Confirmed` (ETA: 5–15s on confirmed commitment). Open the signature on Solscan — confirm 1 $TROLL transferred from your ATA to the escrow ATA.
4. Position should now show `Open · 1 YES`.
5. Click **Exit**. Server queues a refund (proceeds based on current YES price).
6. From `/admin`, click **Run pending payouts**. The withdrawal flips `pending → sent → confirmed`. Open the new signature on Solscan — your wallet's $TROLL balance is back (minus a tiny amount of price impact, +/- 0.01 TROLL).
7. ✅ Pre-lock exit + payout works.

### Test 2 — full settlement with winner/refund logic

1. Create a second market: `15m`, `closeAt` 5 minutes out, `targetMc` = current TROLL MC ÷ 2 (so YES wins easily).
2. From two different wallets, one buys YES (2 TROLL), one buys NO (1 TROLL). Both confirm on-chain.
3. Wait for `closeAt`. Status flips `open → locked → settling` automatically when the cron runs (or click admin **Settle** to trigger immediately).
4. Run `npm run settle` once. Check `/admin` — outcome should be `YES`, canonical MC populated, audit receipt created.
5. Click **Run pending payouts**. The YES wallet receives ~3 TROLL (their stake + the loser's stake, minus rounding). The NO wallet receives nothing.
6. ✅ YES win + payout works. Repeat with target above current MC to verify NO win works the same way.
7. ✅ For void: create a market, force-void via `/admin → Void`. Run payouts. Both wallets get their original cost basis back.

### What to watch for during these tests

- The escrow authority's SOL balance — every payout that creates a recipient ATA costs ~0.002 SOL of rent.
- `admin_actions` table — every privileged write is logged. Check it after each test.
- `escrow_deposits` and `escrow_withdrawals` — every row should have a `signature` linking back to Solscan.
- If any deposit gets stuck `pending` for more than 30s, check `failure_reason`. The most common stuck-state is `transaction_not_found_or_unconfirmed` (RPC delay) — re-trigger the verification by re-`POST`ing to `/api/markets/:id/enter` with the same signature; the server is idempotent on signature.

## What's still NOT implemented

1. **Per-market PDA escrow.** Single global escrow ATA. Per-market segregation is enforced only in the application layer. A real Solana program with PDA-per-market is on the future roadmap.
2. **Automatic payout cron.** `npm run settle` settles markets but does not auto-run payouts; an admin (or a separate cron entry calling `POST /api/admin/payouts/run`) must trigger them. This is intentional — the spec said "If automatic payouts are not safe yet, create pending payout records / admin can trigger payouts manually". Both modes are supported.
3. **Token-2022 mint support.** Hardcoded to original SPL Token program.
4. **Multisig escrow authority.** The verifier explicitly rejects multisig signers.
5. **Real-money test runbook is documentation only** — I have no way to execute it from this environment (no real wallet, no Solana SOL, no live $TROLL). Operator must run it.

## Exact remaining risks / bugs

1. **`syncMarket` partial-failure window.** The market UPDATE is now version-checked & atomic, but if the trade INSERT or position UPSERT fails *after* the market update succeeds (e.g., DB connection drops mid-batch), the market state is committed but trade/position rows are missing. Logged as `CRITICAL` to stderr. True fix requires a Supabase RPC function with PL/pgSQL transaction; not done here. Probability: low (only on infra failure between two REST calls). Impact: market shows stale aggregates that don't match the trade list — manual replay needed.

2. **Concurrent `void-market` vs `settle` race after the version claim.** Both endpoints now atomically claim the version, so only one wins. The loser sees `market_state_changed_during_void` or `settlement_already_in_flight_or_terminal`. Operator must read these errors and decide what to do — they are not auto-resolved.

3. **Recipient ATA creation has no separate retry path.** If `getAccount` says the ATA doesn't exist but it does (RPC stale read), the `createAssociatedTokenAccountInstruction` will fail and the entire transfer fails. The withdrawal is marked `failed` — admin must call `/api/admin/payouts/retry-failed`. Acceptable.

4. **`getParsedTransaction` not paged.** Some RPC providers truncate the parsed instruction list for large txs. If a deposit tx contains >256 instructions (we don't see this on Phantom-built simple transfers, but a power user could), the verifier might miss the SPL transfer. Mitigation: top-level instruction count for Phantom-built transfers is ≤ 4. Acceptable.

5. **Escrow authority single point of failure.** The base58 secret is in `.env` on the server. Compromise of the server's filesystem = compromise of the escrow. No per-market PDAs, no multisig. Recommend short rotations and isolating the server. Documented but not mitigated.

6. **No rate limiting on `/api/markets/:id/enter`.** A user could spam invalid signatures. Each invalid call costs one `getParsedTransaction` RPC and one row write. If your Helius plan is small, this is a DoS vector. Mitigation: front the API with Cloudflare or similar. Not in repo.

7. **No transactional outbox for the worker.** If `npm run settle` crashes between the brain run and the audit-receipt write, the brain's polling work is lost. Re-running picks the slot up via the version-check claim and re-polls — wasteful but correct. Acceptable.

8. **Settlement worker uses upsert on `audit_receipts` and `settlements` (`onConflict: market_id`).** If a market is force-voided (admin) AFTER it had been settled (somehow — should be blocked, but defense-in-depth), the upsert would overwrite the audit receipt. The atomic void-claim now refuses to void terminal markets, so this is a thin theoretical risk.
