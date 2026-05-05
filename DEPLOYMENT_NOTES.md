# Deployment notes — pre-RICHARD-tion.fun production go-live

> **⚠️ CRITICAL: rotate `ADMIN_API_KEY` before launch.**
> The previous value was pasted into a chat transcript and must be treated
> as compromised. **Rotate it in the Render dashboard before doing anything
> else.** Anyone with that key can settle markets, void markets, trigger
> payouts, and seed manual snapshots.
>
> ```bash
> # Generate a fresh key:
> openssl rand -hex 32
> # Set it on Render: Service → Environment → ADMIN_API_KEY → paste new value → save → redeploy.
> # Use the SAME key when calling /api/admin/* endpoints from PowerShell or curl.
> ```

---

## 1. Supabase SQL

Open `RUN_THIS_SQL_IN_SUPABASE.sql`, copy the whole file, and run it once in Supabase SQL Editor. It combines the lifecycle, oracle snapshot cache, and safety migrations into one copy/paste block. It is safe to run more than once.

Advanced/manual option: the separate migration files are also included under `server/db/migrations/`.

If you have stuck "locked" markets from earlier deploys, the optional
**SOFT cleanup** at the bottom of `003_lifecycle_safety.sql` flips them to
`voided` status so the next tick can replace them. Read the comments and
uncomment if needed.

## 2. Render — Web Service config

| Field | Value |
|---|---|
| **Plan** | `free` (or `starter` if you want zero cold-start; either works) |
| **Runtime** | Node |
| **Region** | any |
| **Build command** | `npm install --include=dev --legacy-peer-deps --ignore-scripts && npm run build:server` |
| **Start command** | `npm run server` |

### Render env vars

| Var | Required | Value |
|---|---|---|
| `NODE_VERSION` | ✓ | `24.14.1` (do **not** downgrade) |
| `NODE_ENV` | ✓ | `production` |
| `CORS_ORIGINS` | ✓ | `https://pre-richard-tion.fun,https://www.pre-richard-tion.fun,http://localhost:5173,http://localhost:5174` |
| `DEPOSIT_CONFIRMATION` | ✓ | `confirmed` |
| `ADMIN_API_KEY` | ✓ | **freshly rotated** — see warning at top |
| `SUPABASE_URL` | ✓ | from Supabase project → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | service role, **not** anon |
| `HELIUS_RPC_URL` | ✓ | `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY` |
| `TROLL_MINT` | ✓ | `5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2` |
| `ESCROW_AUTHORITY_SECRET` | ✓ | base58 of the escrow authority keypair (64 bytes) |
| `DEXSCREENER_PAIR_URL` | optional | overrides the default DEX pair address used for snapshots |

Render injects `PORT` automatically — `server/env.ts` picks it up.

## 3. Netlify — frontend env vars

In **Site settings → Environment variables**:

| Var | Value |
|---|---|
| `VITE_API_BASE_URL` | `https://pre-richard-tion-api.onrender.com/api` |
| `VITE_TROLL_MINT` | `5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2` |
| `VITE_HELIUS_RPC_URL` | `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY` |
| `VITE_DEXSCREENER_PAIR_URL` | `https://dexscreener.com/solana/<pair-address>` |
| `VITE_GECKOTERMINAL_POOL_URL` | `https://www.geckoterminal.com/solana/pools/<pool>` |

> The api client composes URLs as ``${VITE_API_BASE_URL}/markets``. Setting
> `VITE_API_BASE_URL` to `https://...com/api` gives `https://...com/api/markets`
> — **don't add `/api` to the path code, that produces `/api/api/markets`**.

After changing env vars, **trigger a fresh deploy** (Netlify only re-bakes
env vars at build time).

`netlify.toml` pins `NODE_VERSION = "22"`. Do not change it to 20.

## 4. Lifecycle automation — single tick cron

The market lifecycle advances via a single cron hitting:

```
POST https://pre-richard-tion-api.onrender.com/api/admin/tick-markets
Header: x-admin-api-key: <ADMIN_API_KEY>
```

Run **every 1 minute**. Choose any of:

- **Render Cron Job** (separate service): set up a cron job that runs
  `curl -fsS -X POST -H "x-admin-api-key: $ADMIN_API_KEY" https://pre-richard-tion-api.onrender.com/api/admin/tick-markets`.
- **GitHub Actions** (free):
  ```yaml
  on:
    schedule: [{ cron: "* * * * *" }]
    workflow_dispatch:
  jobs:
    tick:
      runs-on: ubuntu-latest
      steps:
        - run: |
            curl -fsS -X POST \
              -H "x-admin-api-key: ${{ secrets.ADMIN_API_KEY }}" \
              -H "content-type: application/json" \
              --max-time 50 \
              "https://pre-richard-tion-api.onrender.com/api/admin/tick-markets"
  ```
- **cron-job.org**, **EasyCron**, **fly.io machines**, etc. — all work the same
  way.

**Do not** create three separate seed/settle/payouts cron services. The
single tick endpoint covers settlement and seed in one call. Payouts have
their own user-driven `/claims` flow plus a manual admin endpoint; you don't
need a cron unless you want fully-automatic payouts (cheap to set up
separately if you do).

## 5. Manual test commands

After deploying, run these from your machine to confirm:

### Health + CORS

```bash
API=https://pre-richard-tion-api.onrender.com
SITE=https://pre-richard-tion.fun
ADMIN=<your-rotated-admin-key>

curl -H "Origin: $SITE" -I $API/api/health | grep -i access-control
# → access-control-allow-origin: https://pre-richard-tion.fun
```

### Markets endpoint

```bash
curl $API/api/markets | head -c 300
# → {"markets":[...],"escrowAccount":"..."}
# Should contain 0-3 entries; after the first tick, exactly 3.
```

### Tick — production lifecycle advance

```bash
curl -X POST -H "x-admin-api-key: $ADMIN" \
  -H "content-type: application/json" \
  $API/api/admin/tick-markets | jq
# Expected:
#   {
#     "settled":  [...],
#     "created":  [...],
#     "active":   [{ "scheduleType": "15m", "marketId": "TROLL-15m-N", ... }, ...3 entries],
#     "skipped":  [],
#     "errors":   [],
#     "elapsedMs": <ms>
#   }
```

PowerShell equivalent:
```powershell
$h = @{ "x-admin-api-key" = "$env:ADMIN" }
Invoke-RestMethod -Method Post `
  "https://pre-richard-tion-api.onrender.com/api/admin/tick-markets" `
  -Headers $h | ConvertTo-Json -Depth 5
```

### If both DexScreener and GeckoTerminal are rate-limited

The tick endpoint returns `errors[]` entries like:
```
snapshot_unavailable_no_fresh_cache: dexscreener: dexscreener_429 |
  geckoterminal: geckoterminal_429 | cache: 412s old (max 300s)
```

Unstick the lifecycle with a manual snapshot (pull MC from CoinGecko, your
chart, your RPC — whatever you trust):

```bash
curl -X POST -H "x-admin-api-key: $ADMIN" \
  -H "content-type: application/json" \
  -d '{"marketCap": 46800000, "priceUsd": 0.0000468, "source": "manual_admin"}' \
  $API/api/admin/seed-markets-from-manual-snapshot | jq
```

The manual snapshot is also written to `oracle_snapshots`, so the next
automatic tick has a fallback even if providers stay down. Once they
recover, live fetches resume and replace the manual entry as the most-recent
cached row — fully self-healing.

CLI alternative (no HTTP):

```bash
npm run seed:markets:manual -- --mc 46800000 --price 0.0000468 --source manual_admin
```

## 6. End-to-end prediction flow check

1. Visit https://pre-richard-tion.fun
2. Predict panel shows exactly 3 cards: 15-Minute, Hourly, Daily — all with
   future close timers.
3. Click **Connect** → Phantom modal → approve.
4. Wallet pill shows your $TROLL balance loaded from mint
   `5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2`.
5. Pick a market, type a small amount (e.g., 5), press **MAX** to confirm
   the button fills your real balance.
6. Type 5 again, click **YES** or **NO**, then click **Sign**.
7. Phantom prompts for a `transferChecked` to the escrow ATA. Approve.
8. Server verifies the signature on-chain, then creates a position.
   Browser console shows `[entry/sign] DONE positionId=...`.
9. Refresh: market `volume` and `openInterest` increased; YES/NO prices
   moved.
10. Wait until `closeAt` passes, then either wait for the next cron tick or
    manually fire `/api/admin/tick-markets`. Market settles to YES, NO, or
    VOID.
11. Visit `/claims` (the Payouts pill in the navbar appears automatically
    when you have pending withdrawals). Click **Claim** → wallet receives
    $TROLL.

## 7. Final go-live checklist

- [ ] **`ADMIN_API_KEY` rotated in Render** (the most important box on this list).
- [ ] `RUN_THIS_SQL_IN_SUPABASE.sql` applied in Supabase.
- [ ] All Render env vars set (table in section 2).
- [ ] All Netlify env vars set (table in section 3) and Netlify redeployed.
- [ ] `curl -H "Origin: $SITE" -I $API/api/health` shows
      `access-control-allow-origin: https://pre-richard-tion.fun`.
- [ ] `curl $API/api/markets` returns at least 3 markets after the first tick.
- [ ] Tick cron is running every minute (Render Cron, GitHub Actions,
      whatever you chose).
- [ ] Visit https://pre-richard-tion.fun — landing page shows 3 unlocked
      markets with future timers.
- [ ] Phantom connection works; balance loads from the real mint.
- [ ] A small test trade goes through end-to-end (sign → verify → position).
- [ ] After settlement, the user can either claim a winner payout, or
      receive a void refund (status='voided' markets refund cost basis).
- [ ] Compromised admin key burned (don't leave any reference to the old
      one in repo / Netlify / Render).
