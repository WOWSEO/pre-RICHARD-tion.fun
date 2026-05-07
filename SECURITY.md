# Security & Secrets Policy

## TL;DR
- **Never commit secrets to git.**  No exceptions.
- All real env values live in **Render** (production) or **.env.local** (local dev).
- This repo's `.gitignore` blocks all `.env*` files.  If you're working around
  the gitignore to commit a secret, stop.

## What counts as a secret
Anything that gives someone control over an account or resource.  In this repo:

- `ESCROW_AUTHORITY_SECRET` — the private key of the escrow Solana wallet.
  Whoever has this can drain all SOL in the escrow.
- `SUPABASE_SERVICE_ROLE_KEY` — full read/write access to the production DB.
- `HELIUS_RPC_URL` — contains a Helius API key with rate-limited RPC quota.
- `ADMIN_API_KEY` — authenticates admin endpoints (`/api/admin/*`).

## Where secrets live

| Environment | Where |
|---|---|
| Production backend | Render env vars |
| Production frontend | Vercel env vars (only `VITE_`-prefixed, public-by-design) |
| Local development | `.env.local` (gitignored — never `.env`) |

## What NEVER touches a secret

- `.env` (the unprefixed name — gitignored, but treat as cursed)
- `.env.example` (committed, shows STRUCTURE only, no real values)
- Any chat / screenshot / email
- Any code file
- Notepad documents you save anywhere persistent
- Slack / Discord / Telegram messages

## If a secret leaks

1. **Pause the site** (Vercel → Settings → Pause Project)
2. **Make repo private** if it isn't already
3. **Rotate the leaked secret** — generate new value, update Render
4. **Audit recent activity** — Solscan for the leaked wallet, Helius dashboard for unusual usage, Supabase logs
5. **Identify the leak source** — fix it before anything new gets committed

## Incident: 2026-05-07 escrow keypair drain

The previous escrow authority `HeP3xNcBJVfvrNaxGFVKkjsyoCqKDRTHdA6NS35MQQwu`
was drained 35 seconds after a user deposit because the `.env` file containing
the keypair was committed to a public GitHub repo.  An automated scraper bot
found the secret and ran a sweeper.

**Resolution**: rotated all secrets, repo made private, this `.gitignore` and
SECURITY.md added to prevent recurrence.

**New escrow authority**: see Render env var (current address shown in
`/api/markets` response under `escrowSolAccount`).
