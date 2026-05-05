import { createHash } from "node:crypto";
import type {
  AuditReceipt,
  Market,
  ResolverOutput,
  Snapshot,
  UserSettlement,
} from "./marketTypes";

/**
 * Audit receipt for a settled or voided market.
 *
 * The snapshot bundle hash is sha256 over the canonical-JSON-encoded snapshots
 * array (sorted keys, ISO timestamps). It lets us prove later that the snapshot
 * history we stored is the one we settled against — and remains stable across
 * re-runs as long as the inputs are byte-identical.
 */
export function buildAuditReceipt(
  market: Market,
  snapshots: Snapshot[],
  outcome: ResolverOutput,
  userSettlements: UserSettlement[],
): AuditReceipt {
  return {
    marketId: market.id,
    question: market.question,
    targetMc: market.targetMc,
    closeAt: market.closeAt.toISOString(),
    scheduleType: market.scheduleType,
    perSourceMedian: outcome.perSourceMedian,
    canonicalMc: outcome.canonicalMc,
    outcome: outcome.outcome,
    voidReason: outcome.voidReason,
    finalYesPriceCents: market.yesPriceCents,
    finalNoPriceCents: market.noPriceCents,
    snapshots,
    snapshotBundleHash: hashSnapshots(snapshots),
    userSettlements,
    generatedAt: new Date().toISOString(),
  };
}

/** Pretty-print a receipt to stdout for the simulation script. */
export function printAuditReceipt(receipt: AuditReceipt): void {
  const line = "─".repeat(60);
  console.log(line);
  console.log(`AUDIT RECEIPT  ${receipt.marketId}`);
  console.log(line);
  console.log(`Question:        ${receipt.question}`);
  console.log(`Target MC:       $${formatUsd(receipt.targetMc)}`);
  console.log(`Close at:        ${receipt.closeAt}`);
  console.log(`Schedule:        ${receipt.scheduleType}`);
  console.log("");
  console.log(`Per-source medians:`);
  for (const [k, v] of Object.entries(receipt.perSourceMedian)) {
    console.log(`  ${k.padEnd(18)} ${v == null ? "—" : `$${formatUsd(v)}`}`);
  }
  console.log(
    `Canonical MC:    ${receipt.canonicalMc == null ? "—" : `$${formatUsd(receipt.canonicalMc)}`}`,
  );
  console.log(`Outcome:         ${receipt.outcome}`);
  if (receipt.voidReason) console.log(`Void reason:     ${receipt.voidReason}`);
  console.log(
    `Final YES price: ${receipt.finalYesPriceCents.toFixed(2)}¢   NO: ${receipt.finalNoPriceCents.toFixed(2)}¢`,
  );
  console.log(`Snapshot bundle: sha256:${receipt.snapshotBundleHash}`);
  console.log(`Snapshots:       ${receipt.snapshots.length} total`);
  console.log("");
  console.log(`User settlements (${receipt.userSettlements.length}):`);
  for (const s of receipt.userSettlements) {
    const pnlSign = s.realizedPnlOnSettlement >= 0 ? "+" : "";
    console.log(
      `  ${s.wallet.padEnd(10)} ${s.side.padEnd(3)} ${s.shares.toFixed(2).padStart(9)} sh  ` +
        `entry ${s.averageEntryPriceCents.toFixed(2)}¢  ` +
        `cost ${s.costBasisTroll.toFixed(2).padStart(8)} TROLL  ` +
        `payout ${s.payoutTroll.toFixed(2).padStart(8)} TROLL  ` +
        `PnL ${pnlSign}${s.realizedPnlOnSettlement.toFixed(2)}  ` +
        `(${s.finalStatus})`,
    );
  }
  console.log(line);
}

function hashSnapshots(snapshots: Snapshot[]): string {
  const canonical = JSON.stringify(
    snapshots.map((s) => ({
      source: s.source,
      fetchedAt: s.fetchedAt.toISOString(),
      marketCapUsd: s.marketCapUsd,
      priceUsd: s.priceUsd,
      liquidityUsd: s.liquidityUsd,
      volume24hUsd: s.volume24hUsd,
      ok: s.ok,
      errorText: s.errorText,
    })),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function formatUsd(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(3)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(3)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return n.toFixed(2);
}
