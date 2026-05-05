# Deployment runbook

How to get prerichardtion.fun running with:

- **Frontend**: Netlify, serving the Vite build of `src/`
- **Backend**: Render or Railway, running Express from `server/`
- **Database**: Supabase, schema from `server/db/schema.sql`
- **RPC**: Helius (Solana mainnet)

Deploy the API first, then point Netlify at it.

---

## 0. One-time prep

### Generate the escrow authority

```bash
solana-keygen new --no-bip39-passphrase --outfile escrow.json
# Copy the secret bytes to base58:
node -e 'const k=require("./escrow.json");process.stdout.write(require("bs58").default.encode(Buffer.from(k)))'
# Save the printed string as ESCROW_AUTHORITY_SECRET.

# Fund the authority with ~0.1 SOL — covers ATA creation + ~50 payouts.
solana transfer <ESCROW_AUTHORITY_PUBKEY> 0.1 --from <YOUR_WALLET>

# DELETE escrow.json after you've copied the base58 secret somewhere safe.
# Do NOT commit it.
```

### Apply the database schema

In the Supabase SQL editor, paste and run, in this order:

1. `server/db/schema.sql` — base schema (idempotent; safe to re-run)
2. `server/db/migrations/001_market_lifecycle.sql` — only if you applied
   `schema.sql` from a pre-v6 version
3. `server/db/migrations/002_oracle_snapshots.sql` — adds the
   `oracle_snapshots` cache table used by the tick endpoint to ride out
   DexScreener / GeckoTerminal rate limits

`schema.sql` already contains the `oracle_snapshots` DDL for fresh installs;
the migration file is only for upgrading existing databases.

Then collect:

- `SUPABASE_URL` — from Project Settings → API
- `SUPABASE_SERVICE_ROLE_KEY` — same page (the **service role**, not anon)

### Generate an admin key

```bash
openssl rand -hex 32
# Save as ADMIN_API_KEY.  The /admin page asks for this in the browser.
```

---

## 1. Deploy the API to Render — current recommended method

You already have the clean setup: one Render **Web Service** for the API. Keep using the manual Web Service rather than creating a new Blueprint from scratch.

Render settings:

- **Runtime**: Node
- **Plan**: Free is okay for testing; it may sleep. Upgrade later only if cold starts become a problem.
- **Build Command**:

```bash
npm install --include=dev --legacy-peer-deps --ignore-scripts && npm run build:server
```

- **Start Command**:

```bash
npm run server
```

- **Health Check Path**:

```bash
/healthz
```

Environment variables on the Render Web Service:

| Var                          | Value                                                |
|------------------------------|------------------------------------------------------|
| `NODE_VERSION`               | `24.14.1`                                            |
| `NODE_ENV`                   | `production`                                         |
| `CORS_ORIGINS`               | `https://pre-richard-tion.fun,https://www.pre-richard-tion.fun,http://localhost:5173,http://localhost:5174` |
| `ADMIN_API_KEY`              | your admin secret                                    |
| `SUPABASE_URL`               | from Supabase                                        |
| `SUPABASE_SERVICE_ROLE_KEY`  | from Supabase                                        |
| `HELIUS_RPC_URL`             | `https://mainnet.helius-rpc.com/?api-key=…`          |
| `TROLL_MINT`                 | mainnet $TROLL mint address                          |
| `ESCROW_AUTHORITY_SECRET`    | base58 escrow authority secret                       |
| `DEPOSIT_CONFIRMATION`       | `confirmed`                                          |

Verify:

```bash
curl https://pre-richard-tion-api.onrender.com/healthz
curl https://pre-richard-tion-api.onrender.com/api/markets
```

Do **not** create the old seed/settle/payout crons. Use the single tick endpoint in section 4½.


## 2. Deploy the API to Railway

The repo includes `Procfile`, which Railway reads automatically.

1. https://railway.app → **New Project** → **Deploy from GitHub repo**.
2. Railway detects the Procfile and runs `npm run server`.
3. **Variables** tab — add the same six secrets plus:

   | Var               | Value                                                                |
   |-------------------|----------------------------------------------------------------------|
   | `CORS_ORIGINS`   | `https://pre-richard-tion.fun,https://www.pre-richard-tion.fun`      |
   | `DEPOSIT_CONFIRMATION` | `confirmed`                                                     |

   Railway injects `PORT` automatically.

4. **Settings** → **Networking** → **Generate Domain** to get a public URL
   like `https://prerichardtion-api-production.up.railway.app`.
5. Verify with `curl <url>/healthz`.

For the cron workers on Railway, create three additional services in the
same project:

- New service → **Empty service** → connect same repo →
  - Service 1: **Custom Start Command** = `npm run seed:markets`
  - Service 2: **Custom Start Command** = `npm run settle`
  - Service 3: **Custom Start Command** = `npm run payouts:run`
- For each, set the schedule under **Settings** → **Cron Schedule**
  (Railway only supports cron triggers on paid plans).

If you don't want to pay for cron on Railway, point Render at the same repo
just for the cron services and leave the web on Railway.

---

## 3. Wire Netlify to the production API

1. https://app.netlify.com → connect the repo. Netlify reads `netlify.toml`
   and uses `npm run build` + `dist/` automatically.
2. **Site settings** → **Environment variables** — add:

   | Var                              | Value                                                    |
   |----------------------------------|----------------------------------------------------------|
   | `VITE_API_BASE_URL`              | the Render/Railway URL from §1 or §2 (no trailing slash) |
   | `VITE_TROLL_MINT`                | mainnet $TROLL mint                                      |
   | `VITE_HELIUS_RPC_URL`            | `https://mainnet.helius-rpc.com/?api-key=…`              |
   | `VITE_DEXSCREENER_PAIR_URL`      | `https://dexscreener.com/solana/<pair>`                  |
   | `VITE_GECKOTERMINAL_POOL_URL`    | `https://www.geckoterminal.com/solana/pools/<pool>`      |

3. **Trigger redeploy**. The new bundle will read `VITE_API_BASE_URL` at
   build time and bake it into the JS.
4. Open `https://pre-richard-tion.fun` and confirm:
   - DevTools network tab shows requests going to your Render/Railway URL
   - The 3 lifecycle markets load on the predict panel (15m / hourly / daily)
   - Wallet connection works (Phantom)
   - Balance loads
   - Quote returns
   - Sign flow completes end-to-end with a real $1 deposit

---

## 4. Common failure modes

### CORS rejected (browser console: "blocked by CORS policy")

The server logs `[server] CORS reject origin=...` on every rejection. Three
likely causes:

1. **Netlify deploys an alternate domain** like `<branch>--<site>.netlify.app`.
   Add it to `CORS_ORIGINS` (comma-separated).
2. **www-vs-apex mismatch**. Netlify's primary-domain redirect is HTTP-301,
   so the browser may end up on either `pre-richard-tion.fun` or
   `www.pre-richard-tion.fun` depending on user input. Both are in the
   default allow-list, but if you customized `CORS_ORIGINS`, list both.
3. **Stale legacy `CLIENT_ORIGIN` env var**. Earlier versions of the deploy
   guide used `CLIENT_ORIGIN`; the server still reads it as a back-compat
   fallback. The startup log shows the source explicitly, e.g.:

   ```
   [server] CORS allow-list (source=CORS_ORIGINS, NODE_ENV=production):
     https://pre-richard-tion.fun, https://www.pre-richard-tion.fun, ...
   ```

   If `source=CLIENT_ORIGIN_legacy`, set `CORS_ORIGINS` in your dashboard
   (it wins over the legacy var) and redeploy. If `source=default_*`,
   your env var didn't make it into the running container — re-check
   spelling and re-deploy.

### `/healthz` returns 503 / cold-start delay

Render's `starter` plan keeps the service warm. The free plan sleeps after
15 min of inactivity, adding ~30s to the first request after sleep. If
you're on free, accept the latency or move to starter.

### `Missing required env var: SUPABASE_URL` at boot

The PaaS started the container before you finished entering env vars.
Re-deploy after the env tab is filled out. Also check spelling — the var
names are case-sensitive and the server fails fast if any of the six
required ones are blank.

### Phantom signs but verifyDeposit returns `wrong_source_ata`

The escrow expects the deposit to come from `ATA(TROLL_MINT, user_wallet)`.
If your test wallet imported $TROLL via a non-ATA token account (rare, but
happens with some custodial wallets), the verifier rejects it. Fix on the
wallet side by sending the user's $TROLL to their own ATA first.

### Cron jobs aren't running

Check the cron service logs in Render/Railway. The single tick job should call `POST /api/admin/tick-markets` every minute. If markets stop rolling forward, check the tick job logs and verify it sends the `x-admin-api-key` header.

---

## 4½. Production market automation (tick endpoint)

The simplest way to keep the lifecycle moving in production is a single
1-minute cron hitting `POST /api/admin/tick-markets`.  This endpoint:

1. Settles every market past `close_at` (writes `settlement_mc`,
   `settlement_snapshot_at`, `settlement_result`, `outcome`).
2. Ensures exactly one active market per `schedule_type` (15m / hourly /
   daily) — creates a fresh one with an `open_mc` snapshot if a slot is
   empty.

Returns a structured JSON summary:

```json
{
  "settled":  [{ "marketId": "...", "outcome": "YES", "settlementMc": 42.5e6, "nextMarketId": "..." }],
  "created":  [{ "marketId": "...", "scheduleType": "15m", "openMc": 42.7e6, "closeAt": "..." }],
  "active":   [{ "scheduleType": "15m", "marketId": "...", "status": "open", "closeAt": "..." }, ...],
  "skipped":  [],
  "errors":   [],
  "elapsedMs": 1234
}
```

### Render Cron Job setup

Create **one** cron job only. Do not create the older separate seed / settle / payout crons unless you specifically want those extra services.

Schedule:

```cron
* * * * *
```

Command:

```bash
curl -fsS -X POST \
  -H "x-admin-api-key: $TICK_ADMIN_KEY" \
  -H "content-type: application/json" \
  --max-time 50 \
  "$TICK_URL/api/admin/tick-markets"
```

Cron env vars:

| Var | Value |
|-----|-------|
| `TICK_URL` | `https://pre-richard-tion-api.onrender.com` with no trailing slash |
| `TICK_ADMIN_KEY` | same value as `ADMIN_API_KEY` on the API service |

Verify in the cron logs after the first tick — you should see the JSON response printed.

### External cron alternative

If you don't want to run the cron on Render (e.g., cost), any HTTP cron
service works: `cron-job.org`, GitHub Actions, fly.io machines, k8s
CronJob.  All they need to do is fire a POST every minute with the
`x-admin-api-key` header set to your `ADMIN_API_KEY`.

GitHub Actions example (`.github/workflows/tick.yml`):

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
            "${{ secrets.API_URL }}/api/admin/tick-markets"
```

### Local CLI alternative

Run `npm run tick:markets` from the repo root.  Same logic as the HTTP
endpoint — useful for manual fix-up, local dev, or running from a private
cron host without exposing the admin endpoint to the internet.

### Auth header

The `requireAdmin` middleware accepts EITHER:
- `x-admin-key` (legacy, used by the admin console UI)
- `x-admin-api-key` (preferred for external automation)

Both compare to the same `ADMIN_API_KEY` env var.  Use whichever your
cron tooling makes easier.

---

## 4¾. Snapshot rate-limiting recovery

**Symptom from production logs:** `dexscreener_429 | geckoterminal_429`,
`/api/admin/tick-markets` returns empty `created[]` and `errors[]`, all
three slots empty.

**What changed in v12:**

1. **One snapshot per tick** — the seeder now fetches the live $TROLL MC
   exactly ONCE per tick and reuses it for whichever of {15m, hourly, daily}
   slots are empty.  Previously the tick fetched 3 times and amplified
   rate-limit pressure 3×.
2. **`oracle_snapshots` cache** — every successful live fetch is written
   to a Supabase table.  When both providers 429, the snapshot service
   reads the most-recent cached row.  If it's < 5 min old, it's used in
   place of a live fetch.
3. **Clear errors** — when no fresh cache exists either, the tick endpoint
   surfaces a structured error string in `errors[]`:
   ```
   snapshot_unavailable_no_fresh_cache: dexscreener: dexscreener_429 |
     geckoterminal: geckoterminal_429 | cache: 412s old (max 300s)
   ```
   No more silent empty objects.

**If providers stay rate-limited longer than 5 min** (e.g., DexScreener has
a multi-hour incident), the tick endpoint will surface
`snapshot_unavailable_no_fresh_cache` repeatedly and slots will stay empty.
Use the manual escape hatch:

### Manual snapshot — admin endpoint

Pick a market-cap value from any source you trust at the moment
(CoinGecko, manual chart read, your own RPC) and POST it:

```bash
curl -X POST \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"marketCap": 42500000, "priceUsd": 0.0000425, "source": "coingecko"}' \
  $API/api/admin/seed-markets-from-manual-snapshot
```

Body:
- `marketCap` (required) — USD market cap.  Becomes `open_mc` /
  `target_mc` on every market this call creates.
- `priceUsd` (optional) — display price.  Defaulted from `marketCap`
  if omitted; the value isn't used for settlement math, only display.
- `source` (optional) — free-form label saved with the cached row.

The endpoint:
1. Persists the manual snapshot to `oracle_snapshots` (so subsequent
   automatic ticks fall back to it).
2. Calls `ensureOneActivePerSchedule` with the manual snapshot, creating
   whichever of 15m / hourly / daily are currently empty.
3. Returns `{ ok, snapshot, results }` with a per-schedule `created`
   flag and reason.

### Manual snapshot — local CLI

If you'd rather not expose the endpoint, run from the repo root:

```bash
npm run seed:markets:manual -- --mc 42500000
npm run seed:markets:manual -- --mc 42500000 --price 0.0000425 --source coingecko

# Or via env:
MANUAL_MC=42500000 npm run seed:markets:manual
```

Same logic, same cache write, same outcome — just no HTTP exposure.

### When to STOP using manual seeds

The manual snapshot is a temporary fix.  Once DexScreener / GeckoTerminal
recover, the next automatic tick:
- Successfully fetches a live snapshot
- Writes it to `oracle_snapshots` (replacing your manual entry as the
  "most recent")
- Future ticks revert to using live numbers

You don't need to do anything to "switch back" — the resolution chain is
self-healing.

---

## 5. Post-deploy verification checklist

```bash
API=https://prerichardtion-api.onrender.com   # whatever Render gave you
SITE=https://pre-richard-tion.fun

curl $API/healthz
# → {"ok":true,...}

curl -H "Origin: $SITE" -I $API/api/markets | grep -i access-control
# → access-control-allow-origin: https://pre-richard-tion.fun

curl $API/api/markets | jq '.markets | length'
# → 3   (one each: 15m / hourly / daily, after the seeder's first tick)

curl -X POST -H "x-admin-key: $ADMIN_API_KEY" $API/api/admin/seed-markets
# → {"ok":true,"results":[...]}

curl -X POST -H "x-admin-api-key: $ADMIN_API_KEY" $API/api/admin/tick-markets | jq
# → { settled, created, active, skipped, errors, elapsedMs }
```

When all four return clean responses you're production-ready.
