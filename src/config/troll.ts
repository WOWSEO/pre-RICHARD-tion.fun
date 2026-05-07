// v53 — TROLL is no longer the only coin.  This file is kept as a
// thin re-export so all existing imports of `TROLL` continue to work
// without code changes elsewhere.
//
// New code should import from "./coins" directly:
//   import { TROLL, USDUC, BUTT, COINS, findCoinByMint } from "../config/coins";

export { TROLL } from "./coins";
