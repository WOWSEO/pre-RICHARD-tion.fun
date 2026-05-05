import type { TradeQuote } from "../market/marketTypes";

/**
 * Pre-trade quote preview. Rendered inside the PredictPanel as the user types.
 *
 * All numbers come straight from the brain's `quoteBuyYes`/etc. which is non-mutating —
 * the market state isn't touched until the user hits Confirm.
 */
export function QuotePreview({
  quote,
  side,
}: {
  quote: TradeQuote | null;
  side: "YES" | "NO";
}) {
  const isYes = side === "YES";

  if (!quote) {
    return (
      <div className="rounded-2xl border border-dashed border-ink-200/15 bg-ink-200/5 p-4 text-xs text-ink-100/60">
        Enter an amount to preview your trade.
      </div>
    );
  }

  const arrow = `${quote.marketPriceBeforeCents.toFixed(1)}¢ → ${quote.marketPriceAfterCents.toFixed(1)}¢`;

  return (
    <div
      className={`relative overflow-hidden rounded-2xl ring-1 ${
        isYes ? "bg-yes/8 ring-yes/30" : "bg-no/8 ring-no/30"
      }`}
    >
      <div className="grid grid-cols-2 gap-px bg-ink-200/10">
        <Row label="Estimated shares" value={quote.shares.toFixed(2)} />
        <Row label="Avg price" value={`${quote.avgPriceCents.toFixed(2)}¢`} />
        <Row label="Price impact" value={`${quote.priceImpactCents.toFixed(2)}¢`} />
        <Row label={`${side} book`} value={arrow} mono accent={isYes ? "yes" : "no"} />
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: "yes" | "no";
}) {
  const accentCls = accent === "yes" ? "text-yes-deep" : accent === "no" ? "text-no-deep" : "text-ink-200";
  return (
    <div className="bg-cream-200/95 px-3.5 py-2.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/60">{label}</p>
      <p
        className={`mt-0.5 text-sm font-semibold tabular-nums ${
          mono ? "font-mono" : "font-display"
        } ${accentCls}`}
      >
        {value}
      </p>
    </div>
  );
}
