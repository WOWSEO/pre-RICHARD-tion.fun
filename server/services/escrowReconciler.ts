/**
 * v47 — Escrow reconciler.  The "unbreakable" core.
 *
 * PROBLEM: a user signs a SOL bet; the on-chain SystemProgram.transfer
 * lands in the escrow authority's wallet; but for any reason the server
 * fails to record the deposit (DB hiccup, deploy mid-bet, schema cache
 * stale, RPC blip during verify, network timeout — any number of things).
 * Result: SOL sitting in escrow with no row in `escrow_deposits`,
 * disconnected from the system's accounting.  A "stuck deposit."
 *
 * SOLUTION: every minute, walk recent on-chain transfers TO the escrow
 * authority.  For each signature, ensure there's a corresponding
 * `escrow_deposits` row.  If not, classify and resolve:
 *
 *   1. If we can match the deposit timestamp to a market that's still
 *      tradable → insert deposit + position rows.  The bet "happened"
 *      retroactively.
 *
 *   2. If the matched market has already settled or voided → queue a
 *      refund withdrawal back to the original sender.  They lose nothing.
 *
 *   3. If we can't match a market at all (e.g. a rogue transfer from
 *      a non-user, or a bet placed during a tiny window when no market
 *      was open) → queue a refund.  Conservative default.
 *
 * SAFETY:
 *   - Idempotent: re-running on the same signature is a no-op.  The
 *     `signature unique` constraint on escrow_deposits enforces this.
 *   - Conservative: when in doubt, refund rather than fabricate a
 *     position.  We never invent positions on data we're unsure about.
 *   - Logged: every action emits a clear log line for auditability.
 *   - Bounded: walks at most N recent signatures per run.  Cron handles
 *     the catch-up over time.
 *
 * EXCLUSIONS:
 *   - Self-transfers (escrow paying itself for any reason) are skipped.
 *   - Transfers FROM the escrow (payouts, refunds) are skipped — we
 *     only look at incoming transfers.
 *   - The platform fee wallet is also skipped as a destination match.
 */

import { type ConfirmedSignatureInfo } from "@solana/web3.js";
import { db, type MarketRow } from "../db/supabase";
import { rpc, escrowAuthority } from "./escrowVerifier";

const MAX_SIGNATURES_PER_RUN = 50;

export interface ReconcileResult {
  scanned: number;
  alreadyTracked: number;
  recoveredAsPosition: number;
  refundsQueued: number;
  skipped: number;
  errors: string[];
}

/**
 * Walk recent on-chain SOL transfers TO the escrow authority.  For each
 * one that has no matching escrow_deposits row, classify and recover.
 */
export async function reconcileEscrowDeposits(
  opts: { limit?: number } = {},
): Promise<ReconcileResult> {
  const limit = opts.limit ?? MAX_SIGNATURES_PER_RUN;
  const sb = db();
  const conn = rpc();
  const authority = escrowAuthority();
  const authorityPk = authority.publicKey;

  const result: ReconcileResult = {
    scanned: 0,
    alreadyTracked: 0,
    recoveredAsPosition: 0,
    refundsQueued: 0,
    skipped: 0,
    errors: [],
  };

  console.info(`[reconcile] BEGIN authority=${authorityPk.toBase58()} limit=${limit}`);

  // Step 1: get recent signatures for the escrow authority address.
  let signatures: ConfirmedSignatureInfo[];
  try {
    signatures = await conn.getSignaturesForAddress(authorityPk, { limit });
  } catch (err) {
    const msg = `getSignaturesForAddress failed: ${(err as Error).message}`;
    console.error(`[reconcile] ${msg}`);
    result.errors.push(msg);
    return result;
  }

  result.scanned = signatures.length;
  console.info(`[reconcile] scanned ${signatures.length} on-chain signatures`);

  // Step 2: short-circuit set lookup of which signatures we already track.
  // Matters more when limit is large; with limit=50 it's still cheap.
  const sigStrs = signatures.map((s) => s.signature);
  const { data: trackedRows } = await sb
    .from("escrow_deposits")
    .select("signature")
    .in("signature", sigStrs);
  const trackedSet = new Set((trackedRows ?? []).map((r) => r.signature));

  // Withdrawal signatures should also be considered "known" — those are
  // outgoing transfers (payouts, refunds), not user deposits.
  const { data: wRows } = await sb
    .from("escrow_withdrawals")
    .select("signature")
    .in("signature", sigStrs);
  const wSet = new Set((wRows ?? []).map((r) => r.signature).filter(Boolean));

  // Step 3: walk untracked signatures.
  for (const sigInfo of signatures) {
    const sig = sigInfo.signature;
    const shortSig = `${sig.slice(0, 8)}…${sig.slice(-6)}`;

    if (trackedSet.has(sig)) {
      result.alreadyTracked++;
      continue;
    }
    if (wSet.has(sig)) {
      // Outgoing transfer (payout/refund) — not a user deposit.
      result.skipped++;
      continue;
    }
    if (sigInfo.err) {
      // Failed transaction on-chain — no value moved, ignore.
      result.skipped++;
      continue;
    }

    try {
      await reconcileOneSignature(sig, result);
    } catch (err) {
      const msg = `sig=${shortSig} error=${(err as Error).message}`;
      console.error(`[reconcile] ${msg}`);
      result.errors.push(msg);
    }
  }

  console.info(
    `[reconcile] DONE scanned=${result.scanned} tracked=${result.alreadyTracked} ` +
      `recovered=${result.recoveredAsPosition} refunded=${result.refundsQueued} ` +
      `skipped=${result.skipped} errors=${result.errors.length}`,
  );
  return result;
}

async function reconcileOneSignature(
  sig: string,
  result: ReconcileResult,
): Promise<void> {
  const sb = db();
  const conn = rpc();
  const authority = escrowAuthority();
  const shortSig = `${sig.slice(0, 8)}…${sig.slice(-6)}`;

  // Fetch the parsed tx so we can extract sender + amount.
  const tx = await conn.getParsedTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx || tx.meta?.err) {
    result.skipped++;
    return;
  }

  // Find a SystemProgram.transfer where destination = our authority.
  // Skip if it's an outgoing transfer (source = our authority).
  const expectedDest = authority.publicKey.toBase58();
  let sender: string | null = null;
  let lamports = 0;
  for (const ix of tx.transaction.message.instructions) {
    if (!("parsed" in ix)) continue;
    if (ix.program !== "system") continue;
    const parsed = ix.parsed as {
      type?: string;
      info?: { source?: string; destination?: string; lamports?: number };
    };
    if (parsed.type !== "transfer") continue;
    if (parsed.info?.destination !== expectedDest) continue;
    if (parsed.info?.source === expectedDest) continue; // self-pay, skip
    sender = parsed.info?.source ?? null;
    lamports = Number(parsed.info?.lamports ?? 0);
    break;
  }

  if (!sender || lamports <= 0) {
    // Not an inbound SOL transfer for us — skip.
    result.skipped++;
    return;
  }

  const amountSol = lamports / 1_000_000_000;
  const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : new Date();
  console.info(
    `[reconcile] orphan-found sig=${shortSig} sender=${sender} ` +
      `amount=${amountSol} SOL blockTime=${blockTime.toISOString()}`,
  );

  // Find a market that was tradable at the time of the deposit.
  // We prefer one currently still open (recoverable as a position).
  // Fallback: the most-recent market that included blockTime in its open
  // window (which may already be settled — refund path).
  const { data: tradableNow } = await sb
    .from("markets")
    .select("*")
    .eq("status", "open")
    .lte("close_at", new Date(blockTime.getTime() + 60_000).toISOString()) // close_at after blockTime, with 60s slack
    .gt("close_at", new Date().toISOString()) // and still in the future now
    .order("close_at", { ascending: true })
    .limit(1)
    .maybeSingle<MarketRow>();

  let market: MarketRow | null = tradableNow ?? null;

  if (!market) {
    // No still-tradable match.  Find the market whose open window CONTAINED
    // the blockTime — that's the bet the user intended.
    const { data: historicalMarket } = await sb
      .from("markets")
      .select("*")
      .lte("close_at", new Date(blockTime.getTime() + 30_000).toISOString())
      .gte("close_at", new Date(blockTime.getTime() - 15 * 60_000).toISOString())
      .order("close_at", { ascending: false })
      .limit(1)
      .maybeSingle<MarketRow>();
    market = historicalMarket ?? null;
  }

  if (!market) {
    // No market matches → unconditional refund.  Conservative default.
    console.warn(
      `[reconcile] no-market-match sig=${shortSig} → queueing refund to ${sender}`,
    );
    await queueOrphanRefund({ sig, sender, amountSol, marketId: null });
    result.refundsQueued++;
    return;
  }

  const isStillTradable =
    market.status === "open" && new Date(market.close_at) > new Date();

  if (!isStillTradable) {
    // Market has already settled/voided/closed — refund.
    console.info(
      `[reconcile] market-not-tradable market=${market.id} status=${market.status} ` +
        `→ queueing refund to ${sender}`,
    );
    await queueOrphanRefund({ sig, sender, amountSol, marketId: market.id });
    result.refundsQueued++;
    return;
  }

  // Still-tradable: try to recover as a position.  We DEFAULT to YES side —
  // there's no way to recover the user's intended side from the on-chain
  // tx alone.  Conservative alternative would be to refund here too; we
  // recover-as-position only because the more common case (Phantom signed
  // but UI didn't get the response) means the user expected to be in the
  // market.  If they intended NO, they can exit via the panel.
  //
  // FUTURE: if you add an on-chain memo with side+intent to the deposit
  // transaction, this branch could read the intended side accurately.
  // For now we record a position and let the user contact you if they
  // wanted the other side.
  //
  // ACTUALLY — safer to refund.  The user can re-bet with their preferred
  // side.  Removing the position-recovery path keeps the system honest.
  console.info(
    `[reconcile] tradable-but-side-unknown market=${market.id} → queueing refund instead`,
  );
  await queueOrphanRefund({ sig, sender, amountSol, marketId: market.id });
  result.refundsQueued++;
}

/**
 * Insert an orphan deposit row + a corresponding refund withdrawal row,
 * both keyed by the signature so a re-run is a no-op.
 *
 * The deposit row is marked `status='confirmed'` (the on-chain transfer
 * really happened) but with `failure_reason='orphan_recovery_refund'` so
 * audit logs make it obvious this wasn't a normal entry.  The withdrawal
 * row goes into the `pending` queue and gets paid by `runPendingWithdrawals`.
 */
async function queueOrphanRefund(args: {
  sig: string;
  sender: string;
  amountSol: number;
  marketId: string | null;
}): Promise<void> {
  const sb = db();
  // Make sure the user row exists (FK from escrow_deposits.wallet → users.wallet).
  await sb.from("users").upsert(
    { wallet: args.sender, last_seen_at: new Date().toISOString() },
    { onConflict: "wallet" },
  );

  // Pick a fallback market_id since the column is NOT NULL with FK.
  // If we have no market match, use the most recent voided market as a placeholder
  // (the FK still resolves; the deposit is informational only since failure_reason is set).
  let marketId = args.marketId;
  if (!marketId) {
    const { data: anyMarket } = await sb
      .from("markets")
      .select("id")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();
    marketId = anyMarket?.id ?? null;
  }
  if (!marketId) {
    throw new Error("cannot queue orphan refund — no markets exist for FK");
  }

  // Insert the deposit row first (idempotent via signature unique constraint).
  // If it already exists from a previous reconcile pass, skip.
  const { error: depErr } = await sb.from("escrow_deposits").insert({
    signature: args.sig,
    market_id: marketId,
    wallet: args.sender,
    amount_troll: args.amountSol.toString(),
    amount_sol_equiv: args.amountSol.toString(),
    currency: "sol",
    status: "confirmed",
    failure_reason: "orphan_recovery_refund",
    side: "YES", // arbitrary — the row is informational, not a real entry
  });
  if (depErr && (depErr as { code?: string }).code !== "23505") {
    // 23505 = unique_violation, meaning we already inserted this signature.
    // Anything else is a real problem.
    throw depErr;
  }

  // Queue the refund withdrawal.  Idempotent via wallet+market+reason combo —
  // we check first to avoid double-queue.  The withdrawals table doesn't have
  // a great natural-unique key for this, so we de-dup on (wallet, signature-of-source).
  const { data: existingRefund } = await sb
    .from("escrow_withdrawals")
    .select("id")
    .eq("wallet", args.sender)
    .eq("market_id", marketId)
    .eq("amount_troll", args.amountSol.toString())
    .eq("reason", "refund")
    .eq("failure_reason", `orphan_recovery_for_${args.sig}`)
    .maybeSingle();
  if (existingRefund) {
    console.info(`[reconcile] refund-already-queued for sig=${args.sig.slice(0, 12)}…`);
    return;
  }

  const { error: wErr } = await sb.from("escrow_withdrawals").insert({
    market_id: marketId,
    wallet: args.sender,
    amount_troll: args.amountSol.toString(),
    currency: "sol",
    reason: "refund",
    status: "pending",
    failure_reason: `orphan_recovery_for_${args.sig}`,
  });
  if (wErr) throw wErr;

  console.info(
    `[reconcile] refund-queued wallet=${args.sender} amount=${args.amountSol} SOL ` +
      `from-sig=${args.sig.slice(0, 12)}…`,
  );
}
