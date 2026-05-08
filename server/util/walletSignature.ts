import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

/**
 * Verify a Solana wallet's ed25519 signature over a UTF-8 message.
 *
 * Inputs come from the client as:
 *   - wallet:    base58-encoded pubkey (32 bytes once decoded)
 *   - message:   the canonical message text the user signed
 *   - signature: base64-encoded signature bytes (64 bytes once decoded)
 *
 * Returns true iff the signature is valid for the given pubkey + message.
 * Never throws on invalid input — returns false instead.  This way callers
 * can branch on the boolean without try/catch noise.
 *
 * v55 — introduced to lock down /api/positions/:id/exit, which previously
 * trusted the wallet field in the request body.  Anyone who learned a
 * position UUID could force-exit a stranger's bet at the 3% fee.
 */
export function verifyWalletSignature(args: {
  wallet: string;
  message: string;
  signature: string;
}): boolean {
  try {
    const pubkey = bs58.decode(args.wallet);
    if (pubkey.length !== 32) return false;
    const sigBytes = base64ToBytes(args.signature);
    if (sigBytes.length !== 64) return false;
    const messageBytes = new TextEncoder().encode(args.message);
    return ed25519.verify(sigBytes, messageBytes, pubkey);
  } catch {
    return false;
  }
}

/**
 * Build the canonical exit-intent message, mirroring src/services/walletMessage.ts.
 *
 * MUST stay in sync with the client-side builder.  Any divergence (extra
 * whitespace, different field order, etc.) means valid signatures will fail
 * verification.  When changing this format, bump the version line and update
 * the client at the same time.
 */
export function buildExitMessage(args: {
  wallet: string;
  positionId: string;
  sharesToSell: number | "all";
  timestamp: number;
}): string {
  const lines = [
    "prerichardtion.fun — exit position intent",
    "",
    `wallet:    ${args.wallet}`,
    `position:  ${args.positionId}`,
    `shares:    ${args.sharesToSell === "all" ? "ALL" : args.sharesToSell.toFixed(6)}`,
    `timestamp: ${new Date(args.timestamp).toISOString()}`,
    "",
    "By signing, I confirm I want to exit this position.",
    "Exits cannot be undone and incur a 3% fee.",
  ];
  return lines.join("\n");
}

function base64ToBytes(b64: string): Uint8Array {
  // Node 18+ has Buffer.from(b64, 'base64'), but using an explicit polyfill
  // here keeps this module portable to non-Node runtimes if we ever extract
  // it for shared use.
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
