# v56 — Polymarket-style market-rate exits

Replaces v54.4's cost-basis exit with continuous market-rate pricing. Three files. No SQL migration.

## The math

Every position carries an `averageEntryPriceCents` — the implied probability when you bought (a UI artifact already tracked since v52). Every market exposes a current `yesPriceCents` / `noPriceCents` derived from pool ratios.

Exit fair value:

```
fair_value = stake × (now_price / entry_price)
```

If you bet $100 on YES at 50¢ implied and the market drifts to 80¢, your fair value is $160. If it drifts to 20¢, fair value is $40. Profit and loss-locking, both directions.

## Solvency

Profit on an exit has to come from somewhere. In a real CPMM, it comes from the liquidity pool — funded by LPs who earn fees. We don't have LPs, so profit is funded by the contra-pool (the side betting against you).

The cap:

```
exit_value ≤ stake + contra_pool
```

When the cap binds, you receive the most the market can afford: your stake back plus the entire contra-pool. If you bet $100 YES and the NO pool only has $1, your max exit is $101, even if the share-price math suggests $200.

## Pool accounting

For a YES exit paying out `X`:

```
qYes  -=  stake
qNo   -=  max(0, X − stake)         // profit funded by contra
qYes  +=  max(0, stake − X)         // loss-locked residual stays in side
```

Conservation: `total_pool_after = total_pool_before − X`. The 26 parimutuel tests include a conservation check that asserts this exactly.

## Settlement after exits

Unchanged. Parimutuel rule still applies — winners split `qYes + qNo` proportionally to remaining stakes. Because exits remove stake from the side pool, holders who stayed have a larger share of a smaller pool. The math stays internally consistent regardless of how many exits happen.

This is the same dynamic as Polymarket: late entrants and holders bear the cost of early exits when the market moved in the exiters' direction. NO holders effectively lose value to early-exiting YES bettors when YES becomes favored. They consented to that risk by betting.

## What the user sees

**MyPositions panel** now shows for each open position:
- `In: 0.0500 SOL` — your stake
- `@ 50¢ → 80¢` — entry price → current market price
- `Now: 0.0800 SOL` — fair value at current market price
- `+0.0300 (+60.0%)` — unrealized P/L, color-coded
- `Exit 0.0776` — what you'd receive (net of 3% fee)

**Exit dialog** shows:
- Market-rate proceeds (gross)
- What you receive (net of 3% fee)
- Wallet signature reminder (from v55)

**"Your bets" header** is now visible whether you have positions or not. Empty state prompts you to place your first bet.

## Files

- `src/market/tradeEngine.ts` — `sell()` rewritten with market-rate math, solvency cap, and pool accounting that conserves total
- `src/components/MyPositions.tsx` — fair-value display, market-rate Exit dialog, more visible empty state
- `src/tests/parimutuel.test.ts` — 9 exit tests rewritten for v56 behavior (conservation, solvency cap, profit/loss/breakeven scenarios, partial exits, error cases)

## Verified

- `npm run typecheck` — clean
- `npm test` — 48/48 passing (was 45/45; net +3 from richer test coverage)
- `npm run build` — clean
- `npm run build:server` — clean

## Deploy

No SQL migration needed.

```
unzip the patch over the repo
git add -A
git commit -m "v56: Polymarket-style market-rate exits"
git push origin main
```

Stacks on v54.3-v55. If pushing the whole thing as one commit:

```
v54.3-v56: wording, exits-cost-basis (now superseded), hero, per-coin thresholds, auto-refund, HANTA, quote-dedup, signed-exits, market-rate-exits
```

## Behavior change vs v54.4

v54.4 said exits return cost basis minus 3%. v56 supersedes that: exits return market-rate fair value minus 3%, capped at stake + contra-pool. Same UI surface (Exit button), different math behind it. Anyone who exits a winning position now gets MORE than their stake. Anyone who exits a losing position now gets LESS. This is what you asked for.

## What's still missing (v60+ territory)

True Polymarket has LP-funded liquidity, continuous order matching, and bounded-loss AMM math. We have parimutuel-with-share-pricing, which gets you the user-facing dynamics without the LP infrastructure. Differences in the wild:

- **Profit ceiling**: capped at contra-pool. Polymarket can pay arbitrarily high if liquidity exists.
- **No share trading between users**: exits are always against the pool. Polymarket has a continuous order book.
- **Settlement still parimutuel**: winners split losers' stakes. Polymarket pays $1 per share.

If your users want full Polymarket dynamics later, the path is: introduce an LP layer with explicit subsidy, switch to CPMM for in-window pricing, keep settlement separate. That's a multi-day rewrite. v56 gives you the look and feel of Polymarket in the meantime.

## Why your bets weren't visible before

You saw "no predictions on screen" in your last screenshot for two reasons:

1. **No successful bets yet.** Every bet you've placed has either failed (silent /enter crash, fixed in v54.6) or voided (no_opposition, fixes itself once two-sided participation happens). MyPositions had nothing to display because nothing made it into a real position row.
2. **Empty state was a small line of text.** v56 makes the "Your bets" header always visible with clearer empty-state copy, so you can see the panel exists even when it's empty.

After deploying v54.6 (auto-refund) + v56 (market-rate exits) + getting the seed-markets cron firing, your next bet should appear in MyPositions within seconds and stay there with live P/L until you exit or the market settles.
