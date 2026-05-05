import { Connection, PublicKey } from "@solana/web3.js";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

/**
 * Get the exact $TROLL UI balance for a wallet, summing across all token accounts
 * the wallet owns for the configured TROLL mint.
 *
 *   Uses RPC `getTokenAccountsByOwner` with `jsonParsed` encoding so we can read
 *   `tokenAmount.uiAmount` directly. This matches what Phantom shows in-app.
 *
 * @param walletAddress base58 wallet pubkey
 * @param connection optional pre-built Connection; otherwise built from VITE_HELIUS_RPC_URL
 * @returns exact UI balance as a number (already-decimaled, e.g. 1_420_690.123456)
 */
export async function getTrollBalance(
  walletAddress: string,
  opts?: { connection?: Connection; mint?: string },
): Promise<number> {
  const mintStr = opts?.mint ?? import.meta.env.VITE_TROLL_MINT;
  if (!mintStr) {
    throw new Error(
      "VITE_TROLL_MINT is not configured — set it in .env to read $TROLL balances.",
    );
  }

  const rpc = import.meta.env.VITE_HELIUS_RPC_URL;
  const connection =
    opts?.connection ??
    new Connection(rpc && rpc.length > 0 ? rpc : "https://api.mainnet-beta.solana.com", {
      commitment: "confirmed",
    });

  const ownerPk = new PublicKey(walletAddress);
  const mintPk = new PublicKey(mintStr);

  const result = await connection.getParsedTokenAccountsByOwner(ownerPk, {
    programId: TOKEN_PROGRAM_ID,
    mint: mintPk,
  });

  let total = 0;
  for (const { account } of result.value) {
    // account.data.parsed.info.tokenAmount.uiAmount is the decimal-adjusted balance
    const info = (account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } })
      .parsed?.info?.tokenAmount;
    if (info && typeof info.uiAmount === "number") {
      total += info.uiAmount;
    }
  }
  return total;
}

/** Format a balance for display: 1420690.123 → "1,420,690" (truncated). */
export function formatTrollBalance(amount: number): string {
  if (!Number.isFinite(amount)) return "0";
  if (amount === 0) return "0";
  // Whole-token display for clarity. The brain settles in whole TROLL anyway.
  const whole = Math.floor(amount);
  return whole.toLocaleString("en-US");
}

/** "7Ab12345...xQ2pK9" → "7Ab1...pK9". */
export function shortenAddress(addr: string, head = 4, tail = 4): string {
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
