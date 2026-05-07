import type { CoinWire } from "../services/apiClient";
import { useCoinTicker } from "../hooks/useCoinTicker";

/**
 * v54 — Coin selector tiles.
 *
 * Three (or N) horizontal cards, one per registered coin.  Each card shows:
 *   - logo (or a 2-letter monogram fallback)
 *   - $SYMBOL
 *   - live market cap (own ticker, polls every 2s)
 *
 * The active card is highlighted (purple ring + brighter background).
 * Clicking a card calls onSelect(mint).
 *
 * Layout:
 *   - Desktop: row of N tiles, equal width, ~120-140px tall.
 *   - Mobile: same row, scroll horizontally if needed (CSS handles overflow).
 */
export function CoinSelector({
  coins,
  selectedMint,
  onSelect,
}: {
  coins: CoinWire[];
  selectedMint: string | null;
  onSelect: (mint: string) => void;
}) {
  if (coins.length === 0) {
    // Nothing rendered; the parent shows a loading skeleton elsewhere
    // (the rest of the page works without the selector — single-coin mode).
    return null;
  }

  return (
    <div className="coin-selector" role="tablist" aria-label="Choose a coin to predict">
      {coins.map((coin) => (
        <CoinTile
          key={coin.mint}
          coin={coin}
          active={coin.mint === selectedMint}
          onClick={() => onSelect(coin.mint)}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function CoinTile({
  coin,
  active,
  onClick,
}: {
  coin: CoinWire;
  active: boolean;
  onClick: () => void;
}) {
  const ticker = useCoinTicker(coin);

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`coin-tile ${active ? "active" : ""} ${ticker.error ? "is-stale" : "is-live"}`}
      onClick={onClick}
      title={`${coin.name} · ${coin.mint}`}
    >
      <CoinLogo coin={coin} />
      <div className="coin-tile-meta">
        <strong>${coin.symbol}</strong>
        <span className="coin-tile-mc" aria-live="polite">
          {formatMarketCap(ticker.marketCapUsd)}
        </span>
        <small>{coin.name}</small>
      </div>
      {active && <span className="coin-tile-check" aria-hidden>✓</span>}
    </button>
  );
}

/* ------------------------------------------------------------------------- *
 * Logo / fallback monogram.
 *
 * If imageUrl is set on the registry row, render an <img>.  If the image
 * fails (broken CDN, IPFS gateway down), fall back to a 2-letter monogram.
 * If imageUrl is null, render the monogram directly.
 *
 * Monogram colour cycles deterministically from the symbol — TROLL, USDUC,
 * and BUTT each end up with a stable, distinct hue without hardcoding.
 * ------------------------------------------------------------------------- */
function CoinLogo({ coin }: { coin: CoinWire }) {
  const monogram = coin.symbol.slice(0, 2).toUpperCase();
  const hue = symbolToHue(coin.symbol);
  const fallback = (
    <span
      className="coin-tile-logo monogram"
      aria-hidden
      style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 65% 45%))` }}
    >
      {monogram}
    </span>
  );

  if (!coin.imageUrl) return fallback;

  return (
    <img
      className="coin-tile-logo"
      src={coin.imageUrl}
      alt={`${coin.symbol} logo`}
      onError={(e) => {
        // Replace the broken image with the monogram.  The class swap is the
        // simplest cross-browser approach without forcing a re-render.
        const el = e.currentTarget;
        el.style.display = "none";
        const sibling = el.nextElementSibling;
        if (sibling instanceof HTMLElement) sibling.style.display = "flex";
      }}
    />
  );
}

/* ------------------------------------------------------------------------- */

function symbolToHue(symbol: string): number {
  // Lightweight string-hash → hue.  Collisions are fine — we only need
  // visual distinction across ~3-10 coins, and a hash distributes them
  // well enough.
  let h = 0;
  for (let i = 0; i < symbol.length; i++) {
    h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function formatMarketCap(value: number | null): string {
  if (value == null) return "$--";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(0)}`;
}
