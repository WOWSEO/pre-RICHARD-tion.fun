import type {
  AuditReceipt,
  CoinConfig,
  Market,
  ResolverInput,
  ResolverOutput,
  Snapshot,
  User,
  UserSettlement,
} from "./marketTypes";
import type { MarketCapProvider } from "../providers/providerTypes";
import { tick, closeWindow } from "./scheduler";
import { buildAuditReceipt } from "./auditReceipt";

/**
 * Settlement engine: collect snapshots → resolve → apply payouts → produce
 * an audit receipt.
 *
 * Resolver algorithm (research report §5):
 *   1. For each consensus source in {dexscreener, geckoterminal}:
 *        valid_s   = snapshots where ok=true and mc>0 in the close window
 *        if |valid_s| < minSnapshotsPerSource → VOID(insufficient_snapshots_<src>)
 *        median_s  = median(valid_s.mc)
 *   2. Liquidity / volume floors enforced if any in-window snapshot reports them
 *      below thresholds.
 *   3. If |median_dex − median_gecko| / mean(...) > sourceDisagreementThreshold
 *      → VOID(source_disagreement)
 *   4. canonical_mc = average(median_dex, median_gecko)
 *      (with two sources, average == median.)
 *   5. If |canonical_mc − target| / target < deadZoneThreshold → VOID(dead_zone)
 *   6. outcome = canonical_mc > target ? "YES" : "NO"
 *
 * helius_curve and mock snapshots are ignored for MC consensus — they're
 * recorded for audit only.
 */

// ----- Pure resolver -----

export function resolve(input: ResolverInput): ResolverOutput {
  const {
    market,
    snapshots,
    minLiquidityUsd,
    minVolume24hUsd,
    sourceDisagreementThreshold,
    deadZoneThreshold,
    minSnapshotsPerSource,
  } = input;

  const liqVolReason = checkLiquidityVolumeFloor(
    snapshots,
    minLiquidityUsd,
    minVolume24hUsd,
  );
  if (liqVolReason) {
    return voidOutcome(liqVolReason, snapshots);
  }

  const bySource = groupValidBySource(snapshots);
  const medians: Record<string, number | null> = {
    dexscreener: null,
    geckoterminal: null,
  };
  const validCounts: Record<string, number> = {
    dexscreener: bySource.dexscreener.length,
    geckoterminal: bySource.geckoterminal.length,
  };

  for (const src of ["dexscreener", "geckoterminal"] as const) {
    const arr = bySource[src];
    if (arr.length < minSnapshotsPerSource) {
      return {
        outcome: "VOID",
        voidReason: `insufficient_snapshots_${src}`,
        canonicalMc: null,
        perSourceMedian: medians,
        validSnapshotsBySource: validCounts,
      };
    }
    medians[src] = median(arr.map((s) => s.marketCapUsd!));
  }

  if (medians.dexscreener == null || medians.geckoterminal == null) {
    return voidOutcome("token_data_unavailable", snapshots);
  }

  const md = medians.dexscreener;
  const mg = medians.geckoterminal;
  const meanOfMedians = (md + mg) / 2;
  const disagreement = Math.abs(md - mg) / Math.max(meanOfMedians, 1e-9);
  if (disagreement > sourceDisagreementThreshold) {
    return {
      outcome: "VOID",
      voidReason: "source_disagreement",
      canonicalMc: null,
      perSourceMedian: medians,
      validSnapshotsBySource: validCounts,
    };
  }

  const canonicalMc = meanOfMedians;
  const dead =
    Math.abs(canonicalMc - market.targetMc) / Math.max(market.targetMc, 1e-9);
  if (dead < deadZoneThreshold) {
    return {
      outcome: "VOID",
      voidReason: "dead_zone",
      canonicalMc,
      perSourceMedian: medians,
      validSnapshotsBySource: validCounts,
    };
  }

  // ---------------------------------------------------------------------
  // No-opposition / underfunded-escrow guard.
  //
  // The escrow is fully funded by participant deposits — there is no
  // external market-maker subsidy.  In LMSR, share-count > deposited-troll
  // when shares are bought below 100c (which is always, in [1, 99]).  So
  // if all positions are on the winning side, the brain's payout formula
  // (shares × 1.0) demands more $TROLL than escrow can pay.
  //
  // Conservative rule: if either side has zero open shares at settle time,
  // VOID with reason "no_opposition" and refund every position its cost
  // basis.  This also covers the "single participant" case the spec asked
  // about, and handles markets that close with zero participants (the
  // payout loop simply iterates over no positions).
  //
  // We do NOT void on partial under-funding (e.g., 5 YES + 1 small NO).
  // That's a more subtle correctness check; documented as a remaining gap.
  // ---------------------------------------------------------------------
  const open = market.positions.filter(
    (p) => p.status === "open" || p.status === "locked",
  );
  const yesShares = open
    .filter((p) => p.side === "YES")
    .reduce((acc, p) => acc + p.shares, 0);
  const noShares = open
    .filter((p) => p.side === "NO")
    .reduce((acc, p) => acc + p.shares, 0);
  if (yesShares <= 0 || noShares <= 0) {
    return {
      outcome: "VOID",
      voidReason: "no_opposition",
      canonicalMc,
      perSourceMedian: medians,
      validSnapshotsBySource: validCounts,
    };
  }

  return {
    outcome: canonicalMc > market.targetMc ? "YES" : "NO",
    voidReason: null,
    canonicalMc,
    perSourceMedian: medians,
    validSnapshotsBySource: validCounts,
  };
}

// ----- Snapshot collection -----

export async function collectSnapshotsSynthetic(
  market: Market,
  coin: CoinConfig,
  providers: MarketCapProvider[],
): Promise<Snapshot[]> {
  const { start, end } = closeWindow(market);
  const cadenceMs = market.pollCadenceSeconds * 1000;
  const snapshots: Snapshot[] = [];
  for (
    let t = start.getTime();
    t <= end.getTime() + 1; // inclusive of the end tick
    t += cadenceMs
  ) {
    const fakeNow = new Date(t);
    for (const p of providers) {
      const snap = await p.fetchSnapshot(coin, fakeNow);
      snapshots.push(snap);
    }
  }
  return snapshots;
}

export async function collectSnapshotsLive(
  market: Market,
  coin: CoinConfig,
  providers: MarketCapProvider[],
  sleepMs: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<Snapshot[]> {
  const { start, end } = closeWindow(market);
  const cadenceMs = market.pollCadenceSeconds * 1000;
  const snapshots: Snapshot[] = [];
  const now = new Date();
  if (now < start) await sleepMs(start.getTime() - now.getTime());
  let t = start.getTime();
  while (t <= end.getTime()) {
    const sliceStart = Date.now();
    const fakeNow = new Date(t);
    for (const p of providers) {
      const snap = await p.fetchSnapshot(coin, fakeNow).catch((err) => ({
        source: p.name,
        fetchedAt: fakeNow,
        marketCapUsd: null,
        priceUsd: null,
        liquidityUsd: null,
        volume24hUsd: null,
        ok: false,
        errorText: (err as Error).message,
        rawPayload: { error: String(err) },
      }));
      snapshots.push(snap);
    }
    const elapsed = Date.now() - sliceStart;
    if (elapsed < cadenceMs) await sleepMs(cadenceMs - elapsed);
    t += cadenceMs;
  }
  return snapshots;
}

// ----- Payouts -----

/**
 * Applies the resolver outcome to all open/locked positions in the given market.
 *
 *   YES wins  → YES shares pay 1.0 TROLL each, NO shares pay 0.
 *   NO wins   → NO shares pay 1.0 TROLL each, YES shares pay 0.
 *   VOID      → every position refunded its remaining cost basis. PnL=0.
 *
 * Mutates user balances and position statuses, and records market.outcome,
 * market.settlementMc, market.voidReason, market.status, market.closedAt.
 */
export function applyPayouts(
  market: Market,
  users: User[],
  outcome: ResolverOutput,
  now: Date = new Date(),
): UserSettlement[] {
  if (
    market.status !== "settling" &&
    market.status !== "locked" &&
    market.status !== "open"
  ) {
    return [];
  }
  const userByWallet = new Map(users.map((u) => [u.wallet, u]));
  const settlements: UserSettlement[] = [];
  const open = market.positions.filter(
    (p) => p.status === "open" || p.status === "locked",
  );

  for (const p of open) {
    const user = userByWallet.get(p.wallet);
    if (!user) continue;

    let payoutTroll = 0;
    let pnlOnSettlement = 0;
    let finalStatus: "settled" | "void_refunded" = "settled";

    if (outcome.outcome === "VOID") {
      payoutTroll = p.costBasisTroll;
      pnlOnSettlement = 0;
      finalStatus = "void_refunded";
    } else if (outcome.outcome === p.side) {
      payoutTroll = p.shares * 1.0;
      pnlOnSettlement = payoutTroll - p.costBasisTroll;
    } else {
      payoutTroll = 0;
      pnlOnSettlement = -p.costBasisTroll;
    }

    user.trollBalance += payoutTroll;
    p.realizedPnlTroll += pnlOnSettlement;
    p.status = finalStatus;
    p.updatedAt = now;

    settlements.push({
      wallet: p.wallet,
      positionId: p.id,
      side: p.side,
      shares: p.shares,
      averageEntryPriceCents: p.averageEntryPriceCents,
      costBasisTroll: p.costBasisTroll,
      payoutTroll,
      realizedPnlOnSettlement: pnlOnSettlement,
      finalStatus,
    });
  }

  market.settlementMc = outcome.canonicalMc;
  market.outcome = outcome.outcome;
  market.voidReason = outcome.voidReason;
  market.status = outcome.outcome === "VOID" ? "voided" : "settled";
  market.closedAt = now;
  market.openInterest = 0;

  return settlements;
}

// ----- Resolver helpers -----

function groupValidBySource(snapshots: Snapshot[]): {
  dexscreener: Snapshot[];
  geckoterminal: Snapshot[];
} {
  const dex: Snapshot[] = [];
  const gecko: Snapshot[] = [];
  for (const s of snapshots) {
    if (!s.ok || s.marketCapUsd == null || s.marketCapUsd <= 0) continue;
    if (s.source === "dexscreener") dex.push(s);
    else if (s.source === "geckoterminal") gecko.push(s);
    // helius_curve / mock are ignored for consensus
  }
  return { dexscreener: dex, geckoterminal: gecko };
}

function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function checkLiquidityVolumeFloor(
  snapshots: Snapshot[],
  minLiq: number,
  minVol: number,
): string | null {
  const liqVals: number[] = [];
  const volVals: number[] = [];
  for (const s of snapshots) {
    if (!s.ok) continue;
    if (s.source !== "dexscreener" && s.source !== "geckoterminal") continue;
    if (s.liquidityUsd != null) liqVals.push(s.liquidityUsd);
    if (s.volume24hUsd != null) volVals.push(s.volume24hUsd);
  }
  if (liqVals.length > 0 && Math.max(...liqVals) < minLiq) {
    return "liquidity_below_floor";
  }
  if (volVals.length > 0 && Math.max(...volVals) < minVol) {
    return "volume_below_floor";
  }
  return null;
}

function voidOutcome(reason: string, snapshots: Snapshot[]): ResolverOutput {
  const counts: Record<string, number> = { dexscreener: 0, geckoterminal: 0 };
  for (const s of snapshots) {
    if (!s.ok || s.marketCapUsd == null) continue;
    if (s.source === "dexscreener") counts.dexscreener!++;
    if (s.source === "geckoterminal") counts.geckoterminal!++;
  }
  return {
    outcome: "VOID",
    voidReason: reason,
    canonicalMc: null,
    perSourceMedian: { dexscreener: null, geckoterminal: null },
    validSnapshotsBySource: counts,
  };
}

// ----- Orchestrator -----

export interface SettlementOptions {
  /** Default 0.025 = 2.5%. */
  sourceDisagreementThreshold?: number;
  /** Default 0.001 = 0.1%. */
  deadZoneThreshold?: number;
  /** Default 4. */
  minSnapshotsPerSource?: number;
}

/**
 * End-to-end settlement: collect snapshots, resolve, apply payouts, build the
 * audit receipt.
 *
 * Forces market.status into "settling" before collecting so the brain POC can
 * settle on demand without waiting real time. In production you'd let
 * tick() drive the transition naturally.
 */
export async function settleMarket(args: {
  market: Market;
  coin: CoinConfig;
  providers: MarketCapProvider[];
  users: User[];
  options?: SettlementOptions;
}): Promise<AuditReceipt> {
  const { market, coin, providers, users, options = {} } = args;
  market.status = "settling";

  const snapshots = await collectSnapshotsSynthetic(market, coin, providers);
  const resolverOutput = resolve({
    market,
    snapshots,
    minLiquidityUsd: coin.minLiquidityUsd,
    minVolume24hUsd: coin.minVolume24hUsd,
    sourceDisagreementThreshold: options.sourceDisagreementThreshold ?? 0.025,
    deadZoneThreshold: options.deadZoneThreshold ?? 0.001,
    minSnapshotsPerSource: options.minSnapshotsPerSource ?? 4,
  });

  const userSettlements = applyPayouts(market, users, resolverOutput);
  tick(market, new Date());
  return buildAuditReceipt(market, snapshots, resolverOutput, userSettlements);
}
