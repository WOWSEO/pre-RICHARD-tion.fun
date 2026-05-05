import {
  Connection,
  Keypair,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { loadEnv } from "../env";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

let _conn: Connection | null = null;
let _authority: Keypair | null = null;
let _escrowAta: PublicKey | null = null;
let _trollMint: PublicKey | null = null;

/** Reusable RPC connection. */
export function rpc(): Connection {
  if (_conn) return _conn;
  const env = loadEnv();
  _conn = new Connection(env.HELIUS_RPC_URL, env.DEPOSIT_CONFIRMATION);
  return _conn;
}

/**
 * The escrow authority keypair — server-controlled, owns the escrow token account,
 * and must sign every payout transaction. Loaded once and cached.
 *
 * `ESCROW_AUTHORITY_SECRET` is the base58-encoded 64-byte secret key. NEVER expose.
 */
export function escrowAuthority(): Keypair {
  if (_authority) return _authority;
  const env = loadEnv();
  const secretBytes = bs58.decode(env.ESCROW_AUTHORITY_SECRET);
  if (secretBytes.length !== 64) {
    throw new Error(
      `[escrow] ESCROW_AUTHORITY_SECRET must decode to 64 bytes, got ${secretBytes.length}`,
    );
  }
  _authority = Keypair.fromSecretKey(secretBytes);
  return _authority;
}

export function trollMint(): PublicKey {
  if (_trollMint) return _trollMint;
  _trollMint = new PublicKey(loadEnv().TROLL_MINT);
  return _trollMint;
}

/**
 * The single escrow token account — ATA of (TROLL_MINT, ESCROW_AUTHORITY).
 *
 * In the v1 stub, ALL markets share this ATA. Per-market accounting is enforced
 * in the DB (escrow_deposits / escrow_withdrawals). When a real Solana program
 * with PDA-per-market lands, this function returns the per-market PDA instead
 * and the rest of the codebase doesn't have to change.
 */
export function escrowTokenAccount(): PublicKey {
  if (_escrowAta) return _escrowAta;
  const env = loadEnv();
  if (env.ESCROW_TOKEN_ACCOUNT_OVERRIDE) {
    _escrowAta = new PublicKey(env.ESCROW_TOKEN_ACCOUNT_OVERRIDE);
  } else {
    _escrowAta = getAssociatedTokenAddressSync(trollMint(), escrowAuthority().publicKey);
  }
  return _escrowAta;
}

/* ========================================================================== */
/* Transfer verification                                                       */
/* ========================================================================== */

export interface VerifyDepositInput {
  signature: string;
  expectedSource: string;          // user wallet (base58)
  expectedAmountTroll: number;     // UI amount (decimaled)
  /** Tolerance in TROLL — we allow tiny rounding mismatches so 100.00 == 99.999999... */
  amountToleranceTroll?: number;
}

export interface VerifyDepositResult {
  ok: boolean;
  reason: string | null;
  /** When ok=true, the actual UI amount transferred (may differ slightly from expected). */
  actualAmountTroll: number;
}

/**
 * Verify a user's escrow deposit signature on-chain.
 *
 * Checks (all must hold — any failure rejects the deposit):
 *   1. Transaction is found and not failed
 *   2. Confirmation level meets DEPOSIT_CONFIRMATION
 *   3. Contains exactly one parsed SPL `transfer` or `transferChecked` instruction
 *      at the TOP LEVEL (we don't traverse inner instructions; the client always
 *      builds simple top-level transfers, so anything else is suspicious)
 *   4. Destination ATA = escrowTokenAccount()
 *   5. Mint = TROLL_MINT (inline for transferChecked, via postTokenBalances for transfer)
 *   6. SOURCE TOKEN ACCOUNT = ATA(TROLL_MINT, expectedSource).  Without this check,
 *      a delegated authority on someone else's ATA could fund a position on our books
 *      using funds that aren't theirs.
 *   7. Authority (signer) = expectedSource  (the user's wallet, not a delegate)
 *   8. Amount within tolerance of expectedAmountTroll
 */
export async function verifyDeposit(input: VerifyDepositInput): Promise<VerifyDepositResult> {
  const tolerance = input.amountToleranceTroll ?? 0.000001;
  const escrowAta = escrowTokenAccount();
  const mint = trollMint();
  const conn = rpc();
  const shortSig = `${input.signature.slice(0, 8)}…${input.signature.slice(-6)}`;
  console.info(
    `[verify] BEGIN sig=${shortSig} expectedSource=${input.expectedSource} expectedAmt=${input.expectedAmountTroll}`,
  );

  let expectedSourcePk: PublicKey;
  try {
    expectedSourcePk = new PublicKey(input.expectedSource);
  } catch {
    console.warn(`[verify] reject sig=${shortSig} reason=invalid_expected_source_pubkey`);
    return { ok: false, reason: "invalid_expected_source_pubkey", actualAmountTroll: 0 };
  }
  const expectedSourceAta = getAssociatedTokenAddressSync(mint, expectedSourcePk);

  let tx: ParsedTransactionWithMeta | null;
  try {
    const env = loadEnv();
    // getParsedTransaction's commitment is `Finality` only (confirmed | finalized).
    // If the operator picked "processed" for low-latency, we still need to read at
    // "confirmed" or higher so the tx is actually parseable.
    const readCommitment = env.DEPOSIT_CONFIRMATION === "finalized" ? "finalized" : "confirmed";
    tx = await conn.getParsedTransaction(input.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: readCommitment,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `rpc_error: ${(err as Error).message}`,
      actualAmountTroll: 0,
    };
  }

  if (!tx) {
    return { ok: false, reason: "transaction_not_found_or_unconfirmed", actualAmountTroll: 0 };
  }
  if (tx.meta?.err) {
    return { ok: false, reason: `transaction_failed: ${JSON.stringify(tx.meta.err)}`, actualAmountTroll: 0 };
  }

  // Find SPL transfer instruction(s) at the top level only.  If a complex tx with
  // CPI-based transfers is submitted, we reject — the client always builds a flat
  // transferChecked, so anything else is suspicious or unsupported.
  const instrs = tx.transaction.message.instructions;
  const transfers = instrs.filter((ix): ix is typeof ix & { parsed: { type: string; info: Record<string, unknown> } } => {
    return (
      "parsed" in ix &&
      typeof ix.parsed === "object" &&
      ix.parsed != null &&
      "type" in ix.parsed &&
      (ix.parsed.type === "transfer" || ix.parsed.type === "transferChecked") &&
      ix.programId.equals(TOKEN_PROGRAM_ID)
    );
  });

  if (transfers.length === 0) {
    return { ok: false, reason: "no_spl_transfer_instruction", actualAmountTroll: 0 };
  }
  if (transfers.length > 1) {
    return { ok: false, reason: "multiple_spl_transfer_instructions", actualAmountTroll: 0 };
  }

  const ix = transfers[0]!;
  const info = ix.parsed.info;

  // (4) Destination
  const destination = info.destination as string | undefined;
  if (!destination || destination !== escrowAta.toBase58()) {
    return {
      ok: false,
      reason: `wrong_destination: expected ${escrowAta.toBase58()}, got ${destination ?? "missing"}`,
      actualAmountTroll: 0,
    };
  }

  // (5) Mint — inline for transferChecked, via postTokenBalances for legacy transfer
  if (ix.parsed.type === "transferChecked") {
    const mintStr = info.mint as string | undefined;
    if (mintStr !== mint.toBase58()) {
      return {
        ok: false,
        reason: `wrong_mint: expected ${mint.toBase58()}, got ${mintStr ?? "missing"}`,
        actualAmountTroll: 0,
      };
    }
  } else {
    if (!postBalanceMatchesMint(tx, escrowAta.toBase58(), mint.toBase58())) {
      return { ok: false, reason: "wrong_mint_via_balances", actualAmountTroll: 0 };
    }
  }

  // (6) Source token account must be the user's ATA — protects against a delegated
  // authority moving someone else's TROLL into escrow under our user's wallet.
  const source = info.source as string | undefined;
  if (!source || source !== expectedSourceAta.toBase58()) {
    return {
      ok: false,
      reason: `wrong_source_ata: expected ${expectedSourceAta.toBase58()}, got ${source ?? "missing"}`,
      actualAmountTroll: 0,
    };
  }

  // (7) Authority (signer) must be the expected wallet.  For SPL transfer/transferChecked
  // the parsed structure always exposes `authority` for non-multisig flows — we do NOT
  // fall through to `info.source` (that's the ATA, not the wallet, and would be a confusing
  // bypass).  Multisig is not supported.
  const authority = info.authority as string | undefined;
  if (!authority) {
    return { ok: false, reason: "missing_authority_field", actualAmountTroll: 0 };
  }
  if (authority !== input.expectedSource) {
    return {
      ok: false,
      reason: `wrong_authority: expected ${input.expectedSource}, got ${authority}`,
      actualAmountTroll: 0,
    };
  }

  // (8) Amount — within tolerance
  let actualUi: number;
  if (ix.parsed.type === "transferChecked") {
    const ta = info.tokenAmount as { uiAmount?: number | null } | undefined;
    actualUi = typeof ta?.uiAmount === "number" ? ta.uiAmount : 0;
  } else {
    const decimals = await tokenDecimals(mint);
    const raw = BigInt((info.amount as string) ?? "0");
    actualUi = Number(raw) / 10 ** decimals;
  }

  if (Math.abs(actualUi - input.expectedAmountTroll) > tolerance) {
    console.warn(
      `[verify] reject sig=${shortSig} reason=wrong_amount expected=${input.expectedAmountTroll} actual=${actualUi}`,
    );
    return {
      ok: false,
      reason: `wrong_amount: expected ${input.expectedAmountTroll}, got ${actualUi}`,
      actualAmountTroll: actualUi,
    };
  }

  console.info(`[verify] OK sig=${shortSig} actualAmt=${actualUi}`);
  return { ok: true, reason: null, actualAmountTroll: actualUi };
}

function postBalanceMatchesMint(tx: ParsedTransactionWithMeta, ata: string, mint: string): boolean {
  const post = tx.meta?.postTokenBalances ?? [];
  const accountKeys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === "string" ? k : k.pubkey.toBase58(),
  );
  for (const tb of post) {
    const idx = tb.accountIndex;
    if (accountKeys[idx] === ata && tb.mint === mint) return true;
  }
  return false;
}

let _decimalsCache: number | null = null;
async function tokenDecimals(mint: PublicKey): Promise<number> {
  if (_decimalsCache != null) return _decimalsCache;
  const supply = await rpc().getTokenSupply(mint);
  _decimalsCache = supply.value.decimals;
  return _decimalsCache;
}
