/**
 * Spec-required end-to-end brain simulation for $TROLL.
 *
 * Flow (per spec section 13):
 *   1. Create a $TROLL market targeting $60M MC
 *   2. Give User A, B, C simulated $TROLL balances
 *   3. User A buys YES
 *   4. User B buys NO  → YES/NO prices move
 *   5. User C buys YES later at a different price (entry-price-matters story)
 *   6. User A sells half before lock
 *   7. Market locks
 *   8. Mock MC settles over target
 *   9. YES pays 100¢, NO pays 0¢
 *  10. Final balances + trade history + audit receipt printed
 */
import { TROLL } from "../config/troll";
import { createMarket } from "../market/scheduler";
import {
  buyYes,
  buyNo,
  sellYes,
} from "../market/tradeEngine";
import {
  quoteBuyYes,
  quoteBuyNo,
} from "../market/pricingEngine";
import {
  calculatePositionValue,
  calculateUnrealizedPnL,
} from "../market/positionEngine";
import { MemoryStore } from "../store/memoryStore";
import { MockProvider } from "../providers/mockProvider";
import { settleMarket } from "../market/settlementEngine";
import { printAuditReceipt } from "../market/auditReceipt";
import type { TradeEvent } from "../market/marketTypes";

async function main() {
  banner("PumpArena brain — TROLL prediction market simulation");

  const store = new MemoryStore();
  const alice = store.upsertUser("alice", 1000);
  const bob = store.upsertUser("bob", 1000);
  const carol = store.upsertUser("carol", 1000);

  // 1. Create market: TROLL over $60M MC, closes 60s ago so we can settle on demand.
  const closeAt = new Date(Date.now() - 60_000);
  const market = store.addMarket(
    createMarket({
      symbol: TROLL.symbol,
      scheduleType: "15m",
      closeAt,
      targetMc: 60_000_000,
    }),
  );
  printMarketState(market, "initial");

  // 3. Alice buys YES with 200 TROLL.
  const aliceQuote = quoteBuyYes(market, 200);
  console.log(
    `quote (Alice buy YES 200): ${aliceQuote.shares.toFixed(2)} sh @ avg ${aliceQuote.avgPriceCents.toFixed(2)}¢ ` +
      `(${aliceQuote.marketPriceBeforeCents.toFixed(2)}¢ → ${aliceQuote.marketPriceAfterCents.toFixed(2)}¢, ` +
      `impact ${aliceQuote.priceImpactCents.toFixed(2)}¢)`,
  );
  buyYes(alice, market, 200);
  printMarketState(market, "after Alice buys YES 200");

  // 4. Bob buys NO with 300 TROLL — pushes YES price down hard.
  const bobQuote = quoteBuyNo(market, 300);
  console.log(
    `quote (Bob   buy NO  300): ${bobQuote.shares.toFixed(2)} sh @ avg ${bobQuote.avgPriceCents.toFixed(2)}¢ ` +
      `(NO ${bobQuote.marketPriceBeforeCents.toFixed(2)}¢ → ${bobQuote.marketPriceAfterCents.toFixed(2)}¢)`,
  );
  buyNo(bob, market, 300);
  printMarketState(market, "after Bob buys NO 300");

  // 5. Carol buys YES later — same side as Alice, but at the new (lower) price.
  //    This is the "entry price matters" demonstration: Carol pays less per share.
  const carolQuote = quoteBuyYes(market, 200);
  console.log(
    `quote (Carol buy YES 200): ${carolQuote.shares.toFixed(2)} sh @ avg ${carolQuote.avgPriceCents.toFixed(2)}¢ ` +
      `(YES ${carolQuote.marketPriceBeforeCents.toFixed(2)}¢ → ${carolQuote.marketPriceAfterCents.toFixed(2)}¢)`,
  );
  buyYes(carol, market, 200);
  printMarketState(market, "after Carol buys YES 200");

  // Show open book.
  console.log("\nOpen positions:");
  for (const p of market.positions) {
    const value = calculatePositionValue(p, market);
    const unreal = calculateUnrealizedPnL(p, market);
    console.log(
      `  ${p.wallet.padEnd(6)} ${p.side} ${p.shares.toFixed(2).padStart(9)} sh   ` +
        `entry ${p.averageEntryPriceCents.toFixed(2)}¢   ` +
        `cost ${p.costBasisTroll.toFixed(2).padStart(7)}   ` +
        `value ${value.toFixed(2).padStart(7)}   ` +
        `unreal ${(unreal >= 0 ? "+" : "")}${unreal.toFixed(2)}`,
    );
  }

  // 6. Alice exits half her YES before lock.
  const alicePos = market.positions.find(
    (p) => p.wallet === "alice" && p.side === "YES",
  )!;
  const halfShares = alicePos.shares / 2;
  const aliceExit = sellYes(alice, market, halfShares);
  console.log(
    `\nAlice exits half: sold ${halfShares.toFixed(2)} YES → +${aliceExit.quote.trollAmount.toFixed(2)} TROLL ` +
      `@ avg ${aliceExit.quote.avgPriceCents.toFixed(2)}¢`,
  );
  printMarketState(market, "after Alice's partial exit");

  // 7-8. Settle. Mock MC = $72M (over $60M target → YES wins).
  const dex = new MockProvider("dexscreener", { seed: 1 })
    .setMarketCap(72_000_000)
    .setMarketCapNoise(180_000)
    .setLiquidity(75_000)
    .setVolume24h(150_000);
  const gecko = new MockProvider("geckoterminal", { seed: 2 })
    .setMarketCap(72_400_000)
    .setMarketCapNoise(150_000)
    .setLiquidity(75_000)
    .setVolume24h(150_000);

  const receipt = await settleMarket({
    market,
    coin: TROLL,
    providers: [dex, gecko],
    users: store.users,
  });

  // 10. Print final balances, trade history, audit receipt.
  console.log("\nFinal TROLL balances:");
  for (const u of store.users) {
    console.log(`  ${u.wallet.padEnd(6)} ${u.trollBalance.toFixed(2)}`);
  }

  console.log("\nTrade history (chronological):");
  printTradeHistory(market.trades);

  console.log("");
  printAuditReceipt(receipt);
}

function banner(msg: string) {
  const line = "═".repeat(60);
  console.log(`\n${line}\n${msg}\n${line}\n`);
}

function printMarketState(market: { yesPriceCents: number; noPriceCents: number; volume: number; openInterest: number; yesLiquidity: number; noLiquidity: number }, label: string) {
  console.log(
    `[${label.padEnd(35)}] YES ${market.yesPriceCents.toFixed(2)}¢   NO ${market.noPriceCents.toFixed(2)}¢   ` +
      `qY ${market.yesLiquidity.toFixed(0).padStart(5)}  qN ${market.noLiquidity.toFixed(0).padStart(5)}  ` +
      `vol ${market.volume.toFixed(0)}  OI ${market.openInterest.toFixed(0)}`,
  );
}

function printTradeHistory(trades: TradeEvent[]) {
  for (const t of trades) {
    console.log(
      `  ${t.id.padEnd(8)} ${t.wallet.padEnd(6)} ${t.action.padEnd(8)} ` +
        `${t.shares.toFixed(2).padStart(9)} sh @ ${t.priceCents.toFixed(2)}¢   ` +
        `(book ${t.priceBeforeCents.toFixed(2)}¢ → ${t.priceAfterCents.toFixed(2)}¢)   ` +
        `amt ${t.amountTroll.toFixed(2).padStart(7)} TROLL`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
