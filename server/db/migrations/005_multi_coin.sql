-- ===========================================================================
-- v53 — multi-coin support
-- ===========================================================================
-- Adds a `supported_coins` registry and a `coin_mint` column on markets.
-- Replaces the per-schedule unique index with a per-(coin, schedule) one
-- so each registered coin can have its own 15m/hourly/daily markets.
--
-- Backfill: existing markets are tagged with the TROLL mint
-- (5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2).
--
-- Idempotent — safe to re-run.
-- ===========================================================================

-- ----------------------------------------------------------------------------
-- supported_coins registry
-- ----------------------------------------------------------------------------
create table if not exists supported_coins (
  mint                  text primary key,
  symbol                text not null,
  name                  text not null,
  -- DexScreener token-pairs API endpoint (returns pairs[] with marketCap etc).
  dexscreener_pair_url  text not null,
  -- GeckoTerminal token endpoint.
  geckoterminal_url     text not null,
  -- Public-facing chart URL (DexScreener pair page) for the iframe embed.
  dexscreener_embed_url text not null,
  -- Public-facing GeckoTerminal pool URL.
  geckoterminal_pool_url text not null,
  -- Logo image URL (CDN, IPFS, etc).
  image_url             text,
  -- Settlement floors. Below these, the market voids.
  min_liquidity_usd     numeric not null default 25000,
  min_volume_24h_usd    numeric not null default 10000,
  -- Active = the seeder will create markets for this coin every cycle.
  -- Inactive = markets won't be seeded but existing ones still settle.
  is_active             boolean not null default true,
  -- Display ordering (lower = first in tile UI).
  display_order         integer not null default 1000,
  created_at            timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- markets.coin_mint
-- ----------------------------------------------------------------------------
alter table markets
  add column if not exists coin_mint text;

-- Backfill TROLL mint for existing rows (which were single-coin pre-v53).
update markets
   set coin_mint = '5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2'
 where coin_mint is null;

alter table markets
  alter column coin_mint set not null;

-- FK after backfill (so it doesn't fail if registry is empty during migration order).
-- Not enforced at the DB level because the registry might be deleted-and-rebuilt;
-- the application is the source of truth for which mints are valid.

-- ----------------------------------------------------------------------------
-- Per-coin uniqueness
-- ----------------------------------------------------------------------------
-- Replace the global "one active per schedule" with "one active per (coin, schedule)".
-- This is what lets us run TROLL + USDUC + Buttcoin all in 3 schedules at once.

drop index if exists markets_one_active_per_schedule;

create unique index if not exists markets_one_active_per_coin_schedule
  on markets (coin_mint, schedule_type)
  where status in ('open', 'locked', 'settling');

create index if not exists markets_coin_mint_idx
  on markets (coin_mint);

-- ----------------------------------------------------------------------------
-- Seed the registry
-- ----------------------------------------------------------------------------
insert into supported_coins
  (mint, symbol, name, dexscreener_pair_url, geckoterminal_url,
   dexscreener_embed_url, geckoterminal_pool_url, image_url,
   min_liquidity_usd, min_volume_24h_usd, is_active, display_order)
values
  (
    '5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2',
    'TROLL', 'Troll Cat',
    'https://api.dexscreener.com/token-pairs/v1/solana/5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2',
    'https://api.geckoterminal.com/api/v2/networks/solana/tokens/5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2',
    'https://dexscreener.com/solana/4w2cysotx6czaugmmwg13hdpy4qemg2czekyeqyk9ama',
    'https://www.geckoterminal.com/solana/pools/4w2cysotX6czaUGmmWg13hDpY4QEMG2CzeKYEQyK9Ama',
    null, 25000, 10000, true, 1
  ),
  (
    'CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump',
    'USDUC', 'Unstable Coin',
    'https://api.dexscreener.com/token-pairs/v1/solana/CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump',
    'https://api.geckoterminal.com/api/v2/networks/solana/tokens/CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump',
    'https://dexscreener.com/solana/cb9dduft3zuqxqqsfa1c5ky935tereybw9xjxxhkpump',
    'https://www.geckoterminal.com/solana/tokens/CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump',
    null, 25000, 10000, true, 2
  ),
  (
    'Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump',
    'BUTT', 'Buttcoin',
    'https://api.dexscreener.com/token-pairs/v1/solana/Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump',
    'https://api.geckoterminal.com/api/v2/networks/solana/tokens/Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump',
    'https://dexscreener.com/solana/cxpncmac4ypbs1heypeov3mfrk3a5hevjedcduki4zrd',
    'https://www.geckoterminal.com/solana/tokens/Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump',
    null, 25000, 10000, true, 3
  )
on conflict (mint) do update
  set symbol                 = excluded.symbol,
      name                   = excluded.name,
      dexscreener_pair_url   = excluded.dexscreener_pair_url,
      geckoterminal_url      = excluded.geckoterminal_url,
      dexscreener_embed_url  = excluded.dexscreener_embed_url,
      geckoterminal_pool_url = excluded.geckoterminal_pool_url,
      min_liquidity_usd      = excluded.min_liquidity_usd,
      min_volume_24h_usd     = excluded.min_volume_24h_usd,
      is_active              = excluded.is_active,
      display_order          = excluded.display_order;
