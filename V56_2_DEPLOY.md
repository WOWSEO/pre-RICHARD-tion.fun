# v56.2 — Make MyPositions actually visible (CSS fix)

## What was wrong

`.my-positions` was positioned at `right: 28px` with `bottom: clamp(440px, 50vh, 540px)`. Translation: pinned to the RIGHT side of the viewport, ~440px above the bottom. That spot is exactly where the predict panel sits. The two overlapped and the predict panel won the z-index. The positions panel was literally rendering — just hidden behind the predict card.

You were right that nothing should be overlapping.

## Fix

Moved MyPositions to the bottom-LEFT corner alongside the chart strip, and shifted the chart strip's left edge to make room. Now the bottom row of the page is:

```
[ MyPositions  ][      chart strip      ]
   ~24vw wide        ~rest of width
```

Both are pinned to `bottom: 32px`, both are `clamp(280px, 38vh, 460px)` tall, no overlap with hero or predict. Empty state still shows a clear "Your bets · 0 open" header.

## File

- `src/index.css` — `.my-positions` repositioned, `.chart-strip` left edge shifted, mobile media query updated to keep both flowing naturally on narrow screens

## Verified

- `npm run typecheck` — clean
- `npm test` — 48/48
- `npm run build` — clean

## Deploy

```
unzip the patch
git add src/index.css
git commit -m "v56.2: pin MyPositions bottom-left, fix overlap with predict panel"
git push origin main
```

Vercel redeploys. Hard-refresh. The "Your bets" panel appears in the bottom-left corner. Once you place a successful bet, it shows up there with cost basis, current implied price, fair value, P/L, and the Exit button at market rate.

If MyPositions still doesn't appear: tell me your viewport width (browser dev tools → window.innerWidth in console). The breakpoint switches at 1050px — narrower than that and the panel flows below the predict section instead.
