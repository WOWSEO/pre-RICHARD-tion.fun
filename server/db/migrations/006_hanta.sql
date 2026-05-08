-- v54.6 — add HANTA (Hantavirus) coin to supported_coins
--
-- Pump.fun memecoin.  Liquidity assumed low until measured.  Threshold
-- matches BUTT (15%) until we have real data; can be tightened later via:
--   update supported_coins set min_liquidity_usd = ... where mint = '2tXpgu...';
--
-- Idempotent — safe to re-run.

insert into supported_coins
  (mint, symbol, name, dexscreener_pair_url, geckoterminal_url,
   dexscreener_embed_url, geckoterminal_pool_url, image_url,
   min_liquidity_usd, min_volume_24h_usd, is_active, display_order)
values
  (
    '2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y',
    'HANTA', 'Hantavirus',
    'https://api.dexscreener.com/token-pairs/v1/solana/2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y',
    'https://api.geckoterminal.com/api/v2/networks/solana/tokens/2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y',
    'https://dexscreener.com/solana/2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y',
    'https://www.geckoterminal.com/solana/tokens/2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y',
    null, 25000, 10000, true, 4
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

select symbol, name, mint from supported_coins order by display_order;
