import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { db } from "../db/supabase";
import { escrowAuthority, escrowTokenAccount, rpc, trollMint } from "./escrowVerifier";
import { loadEnv } from "../env";

/**
 * Send a payout / refund / exit transfer from the escrow ATA to a recipient wallet.
 *
 * AUDIT FIX (CRITICAL): the previous implementation read the row's status, decided
 * whether to proceed, then sent the transaction.  Two concurrent workers reading
 * the same 'pending' row would BOTH send transactions — double payout.
 *
 * Now we use an atomic CAS:
 *
 *     UPDATE escrow_withdrawals
 *        SET status = 'sent', sent_at = now()
 *      WHERE id = $id AND status = 'pending'
 *  RETURNING *
 *
 * Only one worker wins the CAS; everyone else sees `not_claimable` and bails.
 *
 * Idempotent at the DB layer:
 *   - already 'sent' or 'confirmed' → no-op
 *   - 'failed' → not retried automatically; admin must reset to 'pending'
 *
 * On RPC failure during send, status is set to 'failed' with the error reason so
 * an operator can investigate before resetting to retry.
 */
export async function sendWithdrawal(withdrawalId: number): Promise<{
  ok: boolean;
  signature: string | null;
  reason: string | null;
}> {
  const sb = db();
  const conn = rpc();
  const authority = escrowAuthority();
  const escrowAta = escrowTokenAccount();
  const mint = trollMint();
  const decimals = await tokenDecimals();

  // ATOMIC CLAIM — only one process can transition pending → sent.
  const { data: claimed, error: claimErr } = await sb
    .from("escrow_withdrawals")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", withdrawalId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle<{
      id: number;
      wallet: string;
      amount_troll: string;
      currency: "troll" | "sol";
      status: string;
    }>();
  if (claimErr) throw claimErr;
  if (!claimed) {
    console.info(`[payout] not-claimable id=${withdrawalId}`);
    return { ok: false, signature: null, reason: "not_claimable" };
  }
  console.info(
    `[payout] claimed id=${withdrawalId} wallet=${claimed.wallet} ` +
      `currency=${claimed.currency} amount=${claimed.amount_troll}`,
  );

  const recipient = new PublicKey(claimed.wallet);

  // -------------------------------------------------------------------------
  // v23 — dispatch by currency.
  //
  // Internal accounting unit is "amount_troll" (legacy column name; v23
  // overloads it to mean "the SOL-equivalent at entry time" for SOL-currency
  // rows).  Both branches honor the 3% platform fee.
  //
  //   currency = 'sol'   → SystemProgram.transfer of native lamports from
  //                       the escrow authority's system account to the user
  //                       wallet.  No ATA management; SOL is native.
  //   currency = 'troll' → legacy SPL transferChecked path.  Preserved for
  //                       backwards compat on pre-v23 rows.
  // -------------------------------------------------------------------------
  const PLATFORM_FEE_BPS = 300; // 3.00%

  if (claimed.currency === "sol") {
    // ----- SOL payout -----
    const amountUiSol = Number.parseFloat(claimed.amount_troll); // overloaded
    const grossLamports = BigInt(Math.round(amountUiSol * LAMPORTS_PER_SOL));
    if (grossLamports <= 0n) {
      console.warn(`[payout] zero-or-negative-amount id=${withdrawalId} (SOL path)`);
      await markFailed(withdrawalId, "zero_or_negative_amount");
      return { ok: false, signature: null, reason: "zero_or_negative_amount" };
    }
    const feeLamports = (grossLamports * BigInt(PLATFORM_FEE_BPS)) / 10_000n;
    const netLamports = grossLamports - feeLamports;
    if (netLamports <= 0n) {
      await markFailed(withdrawalId, "net_after_fee_zero");
      return { ok: false, signature: null, reason: "net_after_fee_zero" };
    }
    console.info(
      `[payout] sol-fee-applied id=${withdrawalId} ` +
        `gross=${grossLamports} fee=${feeLamports} net=${netLamports} bps=${PLATFORM_FEE_BPS}`,
    );

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
    tx.add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: recipient,
        lamports: Number(netLamports), // SystemProgram.transfer takes number not bigint
      }),
    );
    tx.feePayer = authority.publicKey;

    let signature: string;
    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      signature = await sendAndConfirmTransaction(conn, tx, [authority], {
        commitment: loadEnv().DEPOSIT_CONFIRMATION,
      });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[payout] sol-send-failed id=${withdrawalId} reason=${msg}`);
      await markFailed(withdrawalId, msg);
      return { ok: false, signature: null, reason: msg };
    }

    const { error: updErr } = await sb
      .from("escrow_withdrawals")
      .update({ status: "confirmed", signature })
      .eq("id", withdrawalId);
    if (updErr) {
      console.warn(`[payout] post-confirm-update-failed id=${withdrawalId} reason=${updErr.message}`);
    }
    console.info(`[payout] sol-DONE id=${withdrawalId} sig=${signature}`);
    return { ok: true, signature, reason: null };
  }

  // ----- TROLL payout (legacy) -----
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient);
  const amountUi = Number.parseFloat(claimed.amount_troll);
  const rawAmount = BigInt(Math.round(amountUi * 10 ** decimals));

  if (rawAmount <= 0n) {
    console.warn(`[payout] zero-or-negative-amount id=${withdrawalId}`);
    await markFailed(withdrawalId, "zero_or_negative_amount");
    return { ok: false, signature: null, reason: "zero_or_negative_amount" };
  }

  // Same 3% fee policy as SOL path.
  const grossRaw = rawAmount;
  const feeRaw = (grossRaw * BigInt(PLATFORM_FEE_BPS)) / 10_000n;
  const netRaw = grossRaw - feeRaw;
  if (netRaw <= 0n) {
    console.warn(`[payout] net-after-fee-zero id=${withdrawalId} gross=${grossRaw} fee=${feeRaw}`);
    await markFailed(withdrawalId, "net_after_fee_zero");
    return { ok: false, signature: null, reason: "net_after_fee_zero" };
  }
  console.info(
    `[payout] fee-applied id=${withdrawalId} ` +
      `gross=${grossRaw} fee=${feeRaw} net=${netRaw} bps=${PLATFORM_FEE_BPS}`,
  );
  const transferRaw = netRaw;

  // Build tx
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));

  // Create recipient ATA if missing — we pay the rent from the authority
  let needsAta = false;
  try {
    await getAccount(conn, recipientAta);
  } catch {
    needsAta = true;
  }
  if (needsAta) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        authority.publicKey,    // payer
        recipientAta,
        recipient,
        mint,
      ),
    );
  }

  // The actual transfer — transferRaw is gross minus the v21 platform fee.
  tx.add(
    createTransferCheckedInstruction(
      escrowAta,
      mint,
      recipientAta,
      authority.publicKey,
      transferRaw,
      decimals,
    ),
  );

  tx.feePayer = authority.publicKey;

  let signature: string;
  try {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    console.info(
      `[payout] broadcasting id=${withdrawalId} recipientAta=${recipientAta.toBase58()} ` +
        `needsAta=${needsAta} amountUi=${amountUi}`,
    );
    signature = await sendAndConfirmTransaction(conn, tx, [authority], {
      commitment: loadEnv().DEPOSIT_CONFIRMATION,
    });
    console.info(
      `[payout] confirmed id=${withdrawalId} sig=${signature.slice(0, 8)}…${signature.slice(-6)}`,
    );
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[payout] FAILED id=${withdrawalId} reason=${msg}`);
    await markFailed(withdrawalId, msg);
    return { ok: false, signature: null, reason: msg };
  }

  await sb
    .from("escrow_withdrawals")
    .update({
      status: "confirmed",
      signature,
      confirmed_at: new Date().toISOString(),
    })
    .eq("id", withdrawalId);

  return { ok: true, signature, reason: null };
}

async function markFailed(id: number, reason: string): Promise<void> {
  await db()
    .from("escrow_withdrawals")
    .update({ status: "failed", failure_reason: reason })
    .eq("id", id);
}

let _decimals: number | null = null;
async function tokenDecimals(): Promise<number> {
  if (_decimals != null) return _decimals;
  const supply = await rpc().getTokenSupply(trollMint());
  _decimals = supply.value.decimals;
  return _decimals;
}

/**
 * Process every pending withdrawal in batch — call from settlement worker
 * or from the admin `/admin/payouts/run` endpoint.
 *
 * Sequential, not parallel — recipient ATA creation is rent-paying and we want
 * deterministic ordering when triaging.  Note: even if you ran this in parallel,
 * the CAS claim above would prevent double-spend; sequential is for clarity.
 */
export async function runPendingWithdrawals(limit = 50): Promise<{ processed: number; skipped: number }> {
  const sb = db();
  const { data, error } = await sb
    .from("escrow_withdrawals")
    .select("id")
    .eq("status", "pending")
    .order("id", { ascending: true })
    .limit(limit)
    .returns<{ id: number }[]>();
  if (error) throw error;

  let processed = 0;
  let skipped = 0;
  for (const row of data ?? []) {
    try {
      const r = await sendWithdrawal(row.id);
      if (r.ok) processed++;
      else skipped++;
    } catch (err) {
      console.error(`[payout] withdrawal ${row.id} threw`, err);
    }
  }
  return { processed, skipped };
}
