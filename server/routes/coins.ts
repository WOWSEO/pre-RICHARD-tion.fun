import { Router } from "express";
import { db } from "../db/supabase";
import { COINS } from "../../src/config/coins";

export const coinsRouter = Router();

interface SupportedCoinRow {
  mint: string;
  symbol: string;
  name: string;
  dexscreener_pair_url: string;
  geckoterminal_url: string;
  dexscreener_embed_url: string;
  geckoterminal_pool_url: string;
  image_url: string | null;
  min_liquidity_usd: string;
  min_volume_24h_usd: string;
  is_active: boolean;
  display_order: number;
}

interface CoinWire {
  mint: string;
  symbol: string;
  name: string;
  dexscreenerPairUrl: string;
  geckoterminalUrl: string;
  dexscreenerEmbedUrl: string;
  geckoterminalPoolUrl: string;
  imageUrl: string | null;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  isActive: boolean;
  displayOrder: number;
}

/* ========================================================================== */
/* GET /api/coins — list all registered coins                                 */
/*                                                                            */
/* Source of truth = supported_coins table.  Falls back to the hardcoded      */
/* COINS registry in src/config/coins.ts when the table is empty or the       */
/* migration hasn't run yet (so a fresh deploy keeps working).                */
/*                                                                            */
/* Default response includes only is_active=true coins.  Pass ?all=true to    */
/* also see inactive ones (admin/debug).                                      */
/* ========================================================================== */
coinsRouter.get("/", async (req, res, next) => {
  try {
    const includeInactive = req.query.all === "true";
    const sb = db();
    const { data, error } = await sb
      .from("supported_coins")
      .select("*")
      .order("display_order", { ascending: true })
      .returns<SupportedCoinRow[]>();
    if (error) throw error;

    let rows: SupportedCoinRow[] = data ?? [];
    if (!includeInactive) rows = rows.filter((r) => r.is_active);

    if (rows.length === 0) {
      // Fall back to hardcoded registry — keeps the API healthy on a fresh
      // database before the v53 migration has been run.
      const fallback: CoinWire[] = COINS.filter((c) => c.active || includeInactive).map(
        (c, i): CoinWire => ({
          mint: c.mintAddress,
          symbol: c.symbol,
          name: c.name,
          dexscreenerPairUrl: c.dexscreenerSource,
          geckoterminalUrl: c.geckoterminalSource,
          dexscreenerEmbedUrl: c.dexscreenerSource,
          geckoterminalPoolUrl: c.geckoterminalSource,
          imageUrl: null,
          minLiquidityUsd: c.minLiquidityUsd,
          minVolume24hUsd: c.minVolume24hUsd,
          isActive: c.active,
          displayOrder: i + 1,
        }),
      );
      return res.json({ coins: fallback, source: "fallback" });
    }

    const wire: CoinWire[] = rows.map((r) => ({
      mint: r.mint,
      symbol: r.symbol,
      name: r.name,
      dexscreenerPairUrl: r.dexscreener_pair_url,
      geckoterminalUrl: r.geckoterminal_url,
      dexscreenerEmbedUrl: r.dexscreener_embed_url,
      geckoterminalPoolUrl: r.geckoterminal_pool_url,
      imageUrl: r.image_url,
      minLiquidityUsd: Number(r.min_liquidity_usd),
      minVolume24hUsd: Number(r.min_volume_24h_usd),
      isActive: r.is_active,
      displayOrder: r.display_order,
    }));
    res.json({ coins: wire, source: "db" });
  } catch (err) {
    next(err);
  }
});
