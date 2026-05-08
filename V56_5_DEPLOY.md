# v56.5 — Stream-friendly layout (lock the page from visual jitter)

When you're streaming/recording, the page jumps because numbers reflow as digits change. This patch locks it down.

## What was jumping

Three sources:

1. **Variable-width digits.** "$9.68M" → "$10.84M" — the `1` and `$` widths shift, and any container holding the value rebalances in flex layout. Same for clocks (`10:34` ticking past `10:39`).
2. **Timer countdowns reflowing.** "1h 27m 11s" → "27m 11s" loses 4 characters when the hour boundary passes. The whole right-side timer pill shrinks and the predict-head-right alignment hops.
3. **Layout reflows propagating.** When a sub-component re-renders on data refresh (every 5–30s), the browser would recompute layout for the whole hero grid because there was no containment hint.

## The fix

CSS-only, in `src/index.css`:

- `font-variant-numeric: tabular-nums` on every container that shows a ticking number. Makes 0-9 render at the same width regardless of which digits are showing. This is the OpenType `tnum` feature most fonts ship with.
- `min-width` on containers whose total length can change: timer pills get 76px, the wallet/token pill gets 96px, MC value gets 6ch, schedule-card timer gets 56px.
- `contain: layout style` on the predict card and positions panel. Bounds reflow scope so a sub-component re-render doesn't trigger layout recomputation of the entire hero grid.

After this, the only motion you'll see during streaming is:
- Numbers changing in place (no horizontal hop)
- The intentional "Closing soon" pulse animation on near-close markets
- Chart iframe (TradingView's own animations)

Everything else stays put.

## File

- `src/index.css` — appended a new "v56.5 stream stability" block at the bottom

## Verified

- `npm run typecheck` ✓
- `npm run build` ✓
- No JS changes, no test impact

## Deploy

```
unzip the patch
git add src/index.css
git commit -m "v56.5: lock layout against numeric jitter — stream-friendly"
git push origin main
```

Hard-refresh, watch the timer tick from "1h 0m 0s" past the hour boundary into "59m 59s". The number changes in place, the parent doesn't shift. Same for the MC card crossing $9.99M → $10.00M.

If anything specific still jumps after this, screenshot it and tell me which element — I'll target it directly.
