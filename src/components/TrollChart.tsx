import { useMemo } from "react";
import { getChartEmbed } from "../services/chartProvider";

/**
 * Embedded $TROLL chart.
 *
 * Source priority (per spec):
 *   1. DexScreener iframe (if VITE_DEXSCREENER_PAIR_URL is set)
 *   2. GeckoTerminal iframe (if VITE_GECKOTERMINAL_POOL_URL is set)
 *   3. Empty state with link to search by mint on both platforms
 */
export function TrollChart({ height = 420 }: { height?: number }) {
  const embed = useMemo(() => getChartEmbed(), []);

  if (embed.embedUrl) {
    return (
      <div
        className="relative overflow-hidden rounded-2xl ring-1 ring-cream-100/10 bg-ink-200/40"
        style={{ height }}
      >
        <iframe
          src={embed.embedUrl}
          title={`$TROLL chart on ${embed.source}`}
          className="absolute inset-0 h-full w-full"
          loading="lazy"
          referrerPolicy="no-referrer"
          // sandbox allows scripts (charts need them) but blocks top-nav for safety.
          sandbox="allow-scripts allow-same-origin allow-popups"
          allow="clipboard-write"
        />
        <div className="pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-ink-200/80 px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-cream-100/80 ring-1 ring-cream-100/10">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-yes animate-pulse" />
          live · {embed.source}
        </div>
      </div>
    );
  }

  // No chart URL configured — give the user something useful instead of a blank box.
  return (
    <div
      className="grid place-items-center rounded-2xl border border-dashed border-cream-100/15 bg-ink-200/40 p-10 text-center"
      style={{ height }}
    >
      <div className="max-w-md space-y-3">
        <p className="font-display text-lg text-cream-100">No chart URL configured.</p>
        <p className="text-sm text-cream-100/60">
          Set <code className="rounded bg-cream-100/10 px-1.5 py-0.5 font-mono text-cream-100">VITE_DEXSCREENER_PAIR_URL</code>{" "}
          or{" "}
          <code className="rounded bg-cream-100/10 px-1.5 py-0.5 font-mono text-cream-100">VITE_GECKOTERMINAL_POOL_URL</code>{" "}
          in your <code className="rounded bg-cream-100/10 px-1.5 py-0.5 font-mono text-cream-100">.env</code> to embed the live chart.
        </p>
      </div>
    </div>
  );
}
