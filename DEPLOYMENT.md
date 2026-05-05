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

1. `server/db/schema.sql` — base schema (idempotent)
2. `server/db/migrations/001_market_lifecycle.sql` — only if you applied
   `schema.sql` from a pre-v6 version

Then collect:

- `SUPABASE_URL` — from Project Settings → API
- `SUPABASE_SERVICE_ROLE_KEY` — same page (the **service role**, not anon)

### Generate an admin key

```bash
openssl rand -hex 32
# Save as ADMIN_API_KEY.  The /admin page asks for this in the browser.
```

---

## 1. Deploy the API to Render — Blueprint method (recommended)

The repo includes `render.yaml`, which provisions one web service plus
three cron workers (seed, settle, payouts) in one click.

1. Push the repo to GitHub.
2. https://dashboard.render.com → **New** → **Blueprint** → connect the repo.
3. Render reads `render.yaml`, creates four services. Click into each one
   and fill in the **Environment** tab:

   | Var                          | Value                                                |
   |------------------------------|------------------------------------------------------|
   | `ADMIN_API_KEY`              | the openssl-generated string                         |
   | `SUPABASE_URL`               | from Supabase                                        |
   | `SUPABASE_SERVICE_ROLE_KEY`  | from Supabase                                        |
   | `HELIUS_RPC_URL`             | `https://mainnet.helius-rpc.com/?api-key=…`          |
   | `TROLL_MINT`                 | mainnet $TROLL mint address                          |
   | `ESCROW_AUTHORITY_SECRET`    | base58 string from §0                                |

   `CORS_ORIGINS` and `DEPOSIT_CONFIRMATION` already have safe defaults
   in `render.yaml` — leave them.

4. The four services will start. The web service exposes a URL like
   `https://prerichardtion-api.onrender.com`. Verify:

   ```bash
   curl https://prerichardtion-api.onrender.com/healthz
   # → {"ok":true,"time":"2026-…"}
   ```

5. Note the URL — you'll paste it into Netlify in §3.

---

## 1-alt. Deploy the API to Render — manual method

If you don't want to use the Blueprint:

- **New** → **Web Service** → connect repo
- **Runtime**: Node
- **Build Command**: `npm install`
- **Start Command**: `npm run server`
- **Health Check Path**: `/healthz`
- **Environment**: same six secrets as above, plus
  `CORS_ORIGINS=https://pre-richard-tion.fun,https://www.pre-richard-tion.fun`

Then add three **Cron Jobs** (separate Render service type, free):

- `npm run seed:markets` — every minute
- `npm run settle` — every minute
- `npm run payouts:run` — every 2 minutes

All four services need the same six secrets. Render's "Environment Groups"
can DRY this up: create one group with the six secrets, attach to all four.

---

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

Check the cron service logs in Render/Railway. The seeder writes
`[seed] tick ...` every minute; the settler writes `[settle] BEGIN ...`
when there's work to do. If those are silent for 5+ minutes, the cron
service didn't start — check the env vars.

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
```

When all four return clean responses you're production-ready.
