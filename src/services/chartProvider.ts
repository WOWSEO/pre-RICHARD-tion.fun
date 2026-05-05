/**
 * Resolve which chart embed to render for $TROLL.
 *
 * Strategy (per spec):
 *   1. If VITE_DEXSCREENER_PAIR_URL is set, use the DexScreener embed.
 *   2. Otherwise, if VITE_GECKOTERMINAL_POOL_URL is set, use the GeckoTerminal embed.
 *   3. Otherwise, return source: "none" — the chart component shows a polite empty
 *      state and a link out to DexScreener / GeckoTerminal search by mint.
 */

export interface ChartEmbed {
  source: "dexscreener" | "geckoterminal" | "none";
  /** URL safe to set as <iframe src=""> */
  embedUrl: string | null;
  /** External link for the user to open the full chart */
  externalUrl: string | null;
}

/**
 * Convert a DexScreener pair URL like https://dexscreener.com/solana/<addr>
 * into its embed URL (?embed=1&theme=dark) with chart-friendly query params.
 */
function dexScreenerEmbed(pairUrl: string): string {
  // DexScreener public embed mode: append ?embed=1&theme=dark&trades=0&info=0
  const url = new URL(pairUrl);
  url.searchParams.set("embed", "1");
  url.searchParams.set("theme", "dark");
  url.searchParams.set("trades", "0");
  url.searchParams.set("info", "0");
  return url.toString();
}

/**
 * GeckoTerminal embed pattern:
 *   https://www.geckoterminal.com/solana/pools/<addr>?embed=1&info=0&swaps=0
 */
function geckoTerminalEmbed(poolUrl: string): string {
  const url = new URL(poolUrl);
  url.searchParams.set("embed", "1");
  url.searchParams.set("info", "0");
  url.searchParams.set("swaps", "0");
  return url.toString();
}

export function getChartEmbed(): ChartEmbed {
  const dex = (import.meta.env.VITE_DEXSCREENER_PAIR_URL as string | undefined)?.trim();
  const gecko = (import.meta.env.VITE_GECKOTERMINAL_POOL_URL as string | undefined)?.trim();

  if (dex && dex.length > 0) {
    return {
      source: "dexscreener",
      embedUrl: dexScreenerEmbed(dex),
      externalUrl: dex,
    };
  }
  if (gecko && gecko.length > 0) {
    return {
      source: "geckoterminal",
      embedUrl: geckoTerminalEmbed(gecko),
      externalUrl: gecko,
    };
  }
  return { source: "none", embedUrl: null, externalUrl: null };
}
