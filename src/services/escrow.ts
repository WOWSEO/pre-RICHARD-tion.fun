import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";

/**
 * Build, sign with Phantom, and submit a real $TROLL escrow deposit.
 *
 * The transaction is a single `transferChecked` instruction:
 *   from: user's TROLL ATA
 *   to:   escrow TROLL ATA (server-controlled)
 *   mint: TROLL mint
 *   amt:  the quoted UI amount, scaled by token decimals
 *
 * Returns the confirmed signature once the cluster reports it.
 */
export interface DepositArgs {
  wallet: WalletContextState;
  /** RPC connection (use the one from useConnection() so we share rate limits) */
  connection: Connection;
  trollMint: PublicKey;
  escrowTokenAccount: PublicKey;
  amountUi: number;
  decimals: number;
}

export async function depositToEscrow(args: DepositArgs): Promise<string> {
  const { wallet, connection, trollMint, escrowTokenAccount, amountUi, decimals } = args;
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  if (!wallet.signTransaction) {
    throw new Error("This wallet does not support signTransaction. Try Phantom or Solflare.");
  }
  if (!(amountUi > 0)) throw new Error("Amount must be greater than zero.");

  const sourceAta = getAssociatedTokenAddressSync(trollMint, wallet.publicKey);
  const rawAmount = BigInt(Math.round(amountUi * 10 ** decimals));

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
  tx.add(
    createTransferCheckedInstruction(
      sourceAta,
      trollMint,
      escrowTokenAccount,
      wallet.publicKey,
      rawAmount,
      decimals,
    ),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  // Phantom's signTransaction returns the signed Transaction we can broadcast ourselves.
  // We avoid `wallet.sendTransaction` because some wallets pre-set their own preflight
  // commitment that conflicts with the server's verification commitment.
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  // Wait for confirmation at "confirmed" — server verifies at the same level.
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return sig;
}

/** Cache token decimals per mint for the session — they don't change. */
const _decimalsCache = new Map<string, number>();
export async function getTrollDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const key = mint.toBase58();
  const cached = _decimalsCache.get(key);
  if (cached != null) return cached;
  const supply = await connection.getTokenSupply(mint);
  _decimalsCache.set(key, supply.value.decimals);
  return supply.value.decimals;
}

/* ========================================================================== */
/* v23 — SOL deposit (parallel to TROLL deposit above).                        */
/* ========================================================================== */

export interface DepositSolArgs {
  wallet: WalletContextState;
  connection: Connection;
  /**
   * Authority pubkey of the escrow.  This IS the SOL escrow recipient —
   * we don't maintain a separate keypair for SOL escrow.  The same
   * keypair that signs SPL transfers also signs SOL transfers out.
   *
   * Comes from /api/markets's escrowSolAccount field.
   */
  escrowSolAccount: PublicKey;
  /** UI amount in SOL (e.g., 0.1 = 0.1 SOL = 100_000_000 lamports). */
  amountUiSol: number;
}

/**
 * Build, sign, and submit a SOL transfer to the escrow authority's
 * native account.  Returns the confirmed signature.
 *
 * The verifier on the server side accepts a top-level
 * `SystemProgram.transfer` instruction with this exact source/dest/lamports
 * profile — see escrowVerifier.verifySolDeposit.
 */
export async function depositSolToEscrow(args: DepositSolArgs): Promise<string> {
  const { wallet, connection, escrowSolAccount, amountUiSol } = args;
  if (!wallet.publicKey) throw new Error("Wallet not connected.");
  if (!wallet.signTransaction) {
    throw new Error("This wallet does not support signTransaction. Try Phantom or Solflare.");
  }
  if (!(amountUiSol > 0)) throw new Error("Amount must be greater than zero.");

  const lamports = Math.round(amountUiSol * LAMPORTS_PER_SOL);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
  tx.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: escrowSolAccount,
      lamports,
    }),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return sig;
}
