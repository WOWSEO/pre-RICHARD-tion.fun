# prerichardtion.fun

> **YES/NO market-cap prediction markets for $TROLL holders.**
> Real $TROLL escrow · server-side state · Phantom signing · settled by oracle median.

This repo is a single TypeScript project with two runtime entry points:

- **Client** (`src/`) — Vite + React + Solana wallet adapter. Loads markets and positions from the server, builds the SPL escrow transfer, asks Phantom to sign.
- **Server** (`server/`) — Express + Supabase. Owns market state. Verifies every escrow deposit on-chain before crediting a position. Settles markets from DexScreener + GeckoTerminal medians. Sends payouts/refunds with a server-controlled escrow keypair.

The trading **engine** itself (LMSR pricing, scheduler, position bookkeeping, settlement orchestration, deterministic audit receipts) lives in `src/market/` and is shared by both runtimes — the same 61-test brain powers in-process simulation and live trading.

---

## Architecture at a glance

```
┌────────────────┐    sign SPL transfer    ┌─────────────────┐
│  Phantom +     │ ───────────────────────▶│  Solana cluster │
│  React client  │                         │   escrow ATA    │
└────────────────┘                         └─────────────────┘
        │                                          │
        │ POST /enter { signature }                │ getParsedTransaction
        ▼                                          ▼
┌────────────────────────────────────────────────────────┐
│   Express server (server/)                              │
│   • verifies tx on-chain  • runs brain quote/buy/sell   │
│   • LMSR + scheduler imported from src/market/          │
│   • optimistic version-locked writes to Supabase        │
└────────────────────────────────────────────────────────┘
        │                                          │
        ▼                                          ▼
┌────────────────────┐                ┌─────────────────────┐
│  Supabase Postgres │                │   Settlement worker │
│  • markets         │                │   (npm run settle)  │
│  • positions       │                │   • polls oracles   │
│  • trades          │                │   • writes audit    │
│  • escrow_*        │                │   • queues payouts  │
│  • settlements     │                └─────────────────────┘
│  • audit_receipts  │
└────────────────────┘
```

---

## Quick local start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# fill in — at minimum:
#   VITE_TROLL_MINT, VITE_HELIUS_RPC_URL,           (client)
#   ADMIN_API_KEY, SUPABASE_URL,                    (server)
#   SUPABASE_SERVICE_ROLE_KEY, HELIUS_RPC_URL,
#   TROLL_MINT, ESCROW_AUTHORITY_SECRET

# 3. Apply database schema (one-time)
#    Open Supabase → SQL editor → paste server/db/schema.sql → Run

# 4. Start the server
npm run dev:server          # listens on :8787

# 5. Start the client (separate terminal)
npm run dev                 # listens on :5173, proxies /api → :8787

# 6. Hit /admin, enter ADMIN_API_KEY, create your first market
```

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server, with `/api/*` proxied to `http://localhost:8787` |
| `npm run dev:server` | Express server with `tsx watch` — auto-restarts on file changes |
| `npm run server` | Express server, no watch (production) |
| `npm run settle` | One-shot: settle every due market, then send pending payouts. Wire to cron. |
| `npm run build` | Type-check + Vite production bundle to `dist/` |
| `npm run typecheck` | `tsc -b --noEmit` for both client and server projects |
| `npm test` | Run the 61 brain tests (Vitest) |
| `npm run simulate` | Headless 3-user trading simulation against the brain |

---

## Generate the escrow keypair

The server's escrow authority is a server-controlled Keypair. It owns the escrow ATA, signs every payout transaction, and **must never be exposed to the browser**.

```bash
# 1. Generate
solana-keygen new --outfile ./escrow.json --no-bip39-passphrase

# 2. Convert the JSON byte array to base58 (what ESCROW_AUTHORITY_SECRET wants)
node -e '
  import("bs58").then(({ default: bs58 }) => {
    const bytes = JSON.parse(require("fs").readFileSync("./escrow.json"));
    process.stdout.write(bs58.encode(Uint8Array.from(bytes)));
  });
'
# → paste this into ESCROW_AUTHORITY_SECRET in your .env

# 3. Fund it with a little SOL for ATA rent + tx fees (~0.05 SOL is plenty for testing)
solana airdrop 0.5 $(solana-keygen pubkey ./escrow.json) --url devnet
# (use a real top-up on mainnet)

# 4. Delete escrow.json from your machine — the base58 string is the only copy you keep.
shred -u escrow.json
```

The escrow ATA is derived as `getAssociatedTokenAddress(TROLL_MINT, ESCROW_AUTHORITY)`. The server creates it on first deposit if it doesn't exist yet (the depositing user pays the rent).

---

## How the escrow flow actually works

This is the safety-critical path. Read it carefully.

1. **Quote.** Client calls `POST /api/markets/:id/quote` with `{ side, amountTroll }`. Server returns the brain's `TradeQuote` — pure function, no state changes.

2. **Sign.** Client builds a single-instruction `transferChecked` transaction:
   - `from` = user's TROLL ATA
   - `to` = escrow ATA (returned by `GET /api/markets`)
   - `amount` = quoted amount × `10^decimals`
   - signed by user's wallet (Phantom)

3. **Broadcast.** Client calls `connection.sendRawTransaction(...)` then awaits `confirmTransaction(..., "confirmed")`. The Phantom signature lives only on chain — the client doesn't store it locally.

4. **Submit.** Client calls `POST /api/markets/:id/enter` with `{ wallet, side, amountTroll, signature }`.

5. **Verify.** Server inserts an `escrow_deposits` row with `status=pending`, then calls `getParsedTransaction(signature, { commitment: confirmed })` and asserts:
   - tx is found and not failed
   - exactly **one** SPL `transfer` or `transferChecked` instruction
   - destination = our escrow ATA
   - mint = TROLL_MINT
   - signing authority = the wallet that's posting the position
   - amount within `1e-6 TROLL` of the quoted amount
   
   Any mismatch → row marked `failed` with a `failure_reason`, **no position is recorded**, server returns `422`.

6. **Commit.** On success, server runs the brain's `buyYes` / `buyNo` against the in-memory hydrated `Market`, then writes the new trade + position + market state back to Supabase under an **optimistic version lock** on `markets.version`. If two writers race, one fails with `optimistic_lock_conflict` and the deposit is left in a state the admin can investigate.

7. **Stamp.** Server finalises the deposit row to `status=confirmed`, links `trade_id` + `position_id`, and updates the trade row with `escrow_signature` for auditability.

> **Single global escrow ATA (current stub).** All markets share one escrow token account. Per-market accounting lives in the DB (`escrow_deposits`, `escrow_withdrawals`). This is the smallest design that is **safe to ship** — replay protection comes from the unique `signature` column, double-counting is prevented by the optimistic version lock. The next iteration is a Solana program with a PDA per market; when that lands, only `escrowTokenAccount()` in `server/services/escrowVerifier.ts` changes — every other layer stays put.

---

## Settlement worker

`npm run settle` runs:

1. `settleDueMarkets()` — finds every market past close window, polls DexScreener + GeckoTerminal at the schedule's poll cadence, runs the brain's `settleMarket` (median per source → average of medians → outcome / void), then upserts into `settlements` + `audit_receipts` and queues `escrow_withdrawals` for every payout/refund.
2. `runPendingWithdrawals(50)` — sends up to 50 SPL `transferChecked` transactions from the escrow ATA back to winners/refundees, signing with the escrow authority. Idempotent — withdrawals already `sent` or `confirmed` are skipped.

Wire to cron at 30s cadence:

```cron
* * * * * cd /app && /usr/bin/npm run settle >> /var/log/settle.log 2>&1
* * * * * sleep 30 && cd /app && /usr/bin/npm run settle >> /var/log/settle.log 2>&1
```

(Or use a real scheduler like systemd timers / Render cron / Fly machines.)

Manual trigger: `POST /api/admin/settle { marketId }` and `POST /api/admin/payouts/run { limit }` from `/admin`.

---

## Void rules

A market voids (everyone refunded, no fee) when **any** of:

- Source disagreement > 2.5% between DexScreener and GeckoTerminal medians
- Fewer than 4 valid snapshots per source during the close window
- Liquidity < $25k or 24h volume < $10k (Pump.fun rugpit guard)
- Canonical MC within ±0.1% of target (dead-zone — too close to call)
- Any oracle returns no data

These thresholds live in `src/config/troll.ts` and the brain's `src/market/settlementEngine.ts`. The rules + thresholds are part of the audit receipt, so retroactive changes don't apply to past settlements.

---

## Admin panel

`/admin`. Auth = `x-admin-key` header matching `ADMIN_API_KEY` env. Stored in browser sessionStorage only.

Capabilities:

- **Create market** — pick schedule (15m / hourly / daily 7PM ET), target MC in millions, optional close override
- **Void market** — force-voids and queues refunds for every confirmed deposit's cost basis
- **Trigger settle** — runs the settlement worker for one market right now
- **Run pending payouts** — batches every `pending` withdrawal through the escrow keypair
- **View** — escrow account address (with Solscan link), confirmed escrow total, pending withdrawal total, every market with prices/volume/OI, every recent deposit + withdrawal with on-chain status

Every admin action is logged to `admin_actions` with the actor name (`x-admin-actor` header), the payload, and the result.

---

## Acceptance test, end to end

Once Supabase is wired up:

1. `npm run dev:server` and `npm run dev` in two terminals
2. Hit `http://localhost:5173/admin`, enter your `ADMIN_API_KEY`, create a 15-minute market with target MC $60M
3. Open `http://localhost:5173/troll` in another browser tab — the market shows up
4. Connect Phantom that holds some real $TROLL on mainnet
5. Click YES on the market, type 100, click "Sign $TROLL entry (YES)"
6. Phantom prompts; sign
7. Watch the phase badge cycle "Awaiting Phantom… → Broadcasting transfer… → Verifying on-chain…"
8. Position confirmed appears in your positions; Solscan shows the deposit signature
9. Before lock: click Exit — server queues an `escrow_withdrawals` row, admin runs payouts → real $TROLL lands back in your wallet
10. After lock: settlement worker resolves outcome, audit receipt at `/audit/<id>` shows the snapshot bundle hash, payouts dispatch automatically

If anything in that chain fails, the failure reason surfaces in the admin recent-deposits / recent-withdrawals lists with a Solscan link.

---

## Repo layout

```
prerichardtion-fun/
├── package.json                    type=module, scripts for both runtimes
├── vite.config.ts                  /api proxy → :8787 in dev
├── tsconfig.app.json               client TS project (src/**/*)
│
├── src/                            CLIENT
│   ├── App.tsx                     routes: / · /troll · /market · /audit · /admin
│   ├── pages/                      4 user pages + AdminPage
│   ├── components/                 PredictPanel (real escrow), EscrowStatus,
│   │                               ClaimablePayouts, MarketCard, etc.
│   ├── hooks/
│   │   ├── useServerMarkets.ts     polls /api/markets — replaces in-memory store
│   │   ├── useTrollBalance.ts      live SPL balance read
│   │   └── useCountdown.ts
│   ├── services/
│   │   ├── apiClient.ts            typed fetch wrapper (incl. admin key support)
│   │   ├── escrow.ts               builds + signs + broadcasts SPL transfer
│   │   └── trollBalance.ts
│   ├── wallet/SolanaProvider.tsx   wallet-adapter context
│   │
│   ├── market/                     ── BRAIN (shared between runtimes) ──
│   │   ├── pricingEngine.ts        LMSR + clamp
│   │   ├── tradeEngine.ts          buyYes/buyNo/sellYes/sellNo
│   │   ├── scheduler.ts            createMarket, lock windows, status transitions
│   │   ├── positionEngine.ts       per-position bookkeeping
│   │   ├── settlementEngine.ts     resolve + applyPayouts + settleMarket
│   │   └── auditReceipt.ts         deterministic sha256 receipts
│   ├── providers/                  DexScreener + GeckoTerminal + Helius adapters
│   ├── config/troll.ts             $TROLL coin config
│   └── tests/                      4 test files, 61 specs
│
├── server/                         SERVER
│   ├── tsconfig.json               module=ESNext, moduleResolution=Bundler
│   ├── env.ts                      fail-fast env validation
│   ├── index.ts                    Express bootstrap
│   ├── db/
│   │   ├── schema.sql              ── 10-table migration (run once in Supabase) ──
│   │   ├── supabase.ts             typed client + row types
│   │   └── marketLoader.ts         brain Market ↔ DB rows + version-locked sync
│   ├── routes/
│   │   ├── markets.ts              GET /, GET /:id, POST /:id/quote, POST /:id/enter
│   │   ├── positions.ts            POST /:id/exit, GET /, GET /withdrawals
│   │   ├── audit.ts                GET /:marketId
│   │   └── admin.ts                create/void/settle/payouts (gated by x-admin-key)
│   ├── services/
│   │   ├── escrowVerifier.ts       on-chain SPL transfer verification
│   │   ├── payoutEngine.ts         signed transfers from escrow → recipient
│   │   └── settlementOrchestrator.ts  brain → DB persistence
│   └── workers/
│       └── settle.ts               npm run settle entry point (cron-friendly)
```

---

## Limits / known gaps

These are **deliberate** (per the spec) and tracked for future work:

- **No multi-coin.** `src/config/troll.ts` is the only coin config.
- **No sponsor pools, missions, lottery, arcade.** Just YES/NO markets.
- **Single global escrow ATA, not a Solana program.** Replay protection via unique `signature` column. Per-market accounting in DB. PDA-per-market is the planned next step — only `escrowTokenAccount()` changes.
- **Manual `runPayouts`.** The settlement worker queues withdrawals but the operator triggers the actual SPL sends from `/admin` (or via cron). This avoids any auto-spend until you've eyeballed the first few rounds.
- **No on-chain pre-flight check for user TROLL balance** before broadcasting — the client shows the live balance and warns on insufficient funds, but the `transferChecked` will fail at the cluster if they really don't have it. Server only commits a position after the on-chain transfer confirms, so an under-funded user never gets credit.

---

18+. Real $TROLL. Holder vs holder. Median of two oracles. sha256 audit receipts.
