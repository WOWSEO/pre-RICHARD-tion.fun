import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { Side } from "../market/marketTypes";

/**
 * In the shell/MVP, no real $TROLL ever leaves the user's wallet. Instead, the
 * user signs a deterministic message confirming the simulated position intent.
 * The signature lets us prove "this wallet authorized this paper trade" — useful
 * for auditing / leaderboards, with zero on-chain footprint.
 *
 * Real escrow can later replace this by signing an SPL token transfer instead.
 */

export interface SimulatedIntent {
  wallet: string;
  marketId: string;
  side: Side;
  amountTroll: number;
  /** Unix epoch ms */
  timestamp: number;
}

/**
 * Builds the canonical message text the user signs. Stable across versions —
 * any client that recreates the same fields will produce the same bytes, which
 * means the same signature can be verified by anyone holding the wallet pubkey.
 */
export function buildIntentMessage(intent: SimulatedIntent): string {
  const lines = [
    "prerichardtion.fun — simulated position intent",
    "",
    `wallet:    ${intent.wallet}`,
    `market:    ${intent.marketId}`,
    `side:      ${intent.side}`,
    `amount:    ${intent.amountTroll.toFixed(2)} TROLL`,
    `timestamp: ${new Date(intent.timestamp).toISOString()}`,
    "",
    "By signing, I confirm I want to enter this YES/NO prediction position",
    "on simulated $TROLL. No real tokens will move from my wallet.",
  ];
  return lines.join("\n");
}

export interface SignedIntent {
  intent: SimulatedIntent;
  message: string;
  /** base64-encoded signature bytes */
  signature: string;
}

/**
 * Ask the connected wallet to sign the intent message.
 *
 * Throws if the wallet doesn't expose `signMessage` (a few hardware wallets and
 * mobile-only adapters don't). Falls back to throwing rather than silently
 * "succeeding" — callers must show the user an error.
 */
export async function signSimulatedIntent(
  wallet: WalletContextState,
  intent: SimulatedIntent,
): Promise<SignedIntent> {
  if (!wallet.publicKey || !wallet.connected) {
    throw new Error("Wallet not connected.");
  }
  if (!wallet.signMessage) {
    throw new Error(
      "This wallet does not support message signing. Try Phantom or Solflare.",
    );
  }
  const message = buildIntentMessage(intent);
  const bytes = new TextEncoder().encode(message);
  const sigBytes = await wallet.signMessage(bytes);
  const signature = bytesToBase64(sigBytes);
  return { intent, message, signature };
}

/** Persist a signed intent into localStorage so the position survives a refresh. */
export function persistSignedIntent(signed: SignedIntent): void {
  try {
    const key = "prerichardtion:intents";
    const raw = localStorage.getItem(key);
    const arr: SignedIntent[] = raw ? JSON.parse(raw) : [];
    arr.push(signed);
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {
    // localStorage is best-effort; if blocked (private mode), the in-memory
    // store still has the position for this session.
  }
}

export function loadSignedIntents(wallet?: string): SignedIntent[] {
  try {
    const raw = localStorage.getItem("prerichardtion:intents");
    if (!raw) return [];
    const arr = JSON.parse(raw) as SignedIntent[];
    return wallet ? arr.filter((s) => s.intent.wallet === wallet) : arr;
  } catch {
    return [];
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/* ============================================================================ */
/* v55 — exit-position signing.                                                 */
/*                                                                              */
/* The /api/positions/:id/exit endpoint requires a wallet signature over a      */
/* canonical message naming (wallet, positionId, shares, timestamp).  Without   */
/* this, anyone who learned a position UUID could force-exit a stranger's bet.  */
/*                                                                              */
/* The message format MUST stay byte-for-byte identical to the server-side      */
/* builder in server/util/walletSignature.ts — any divergence (whitespace,      */
/* field order, formatting) makes valid signatures fail.                        */
/* ============================================================================ */

export interface ExitIntent {
  wallet: string;
  positionId: string;
  /** Either a numeric shares amount or "all" for full exit. */
  sharesToSell: number | "all";
  /** Unix epoch ms.  Server rejects signatures older than 5 minutes. */
  timestamp: number;
}

export function buildExitMessage(intent: ExitIntent): string {
  const lines = [
    "prerichardtion.fun — exit position intent",
    "",
    `wallet:    ${intent.wallet}`,
    `position:  ${intent.positionId}`,
    `shares:    ${intent.sharesToSell === "all" ? "ALL" : intent.sharesToSell.toFixed(6)}`,
    `timestamp: ${new Date(intent.timestamp).toISOString()}`,
    "",
    "By signing, I confirm I want to exit this position.",
    "Exits cannot be undone and incur a 3% fee.",
  ];
  return lines.join("\n");
}

export interface SignedExitIntent {
  intent: ExitIntent;
  message: string;
  /** base64-encoded signature bytes */
  signature: string;
}

export async function signExitIntent(
  wallet: WalletContextState,
  intent: ExitIntent,
): Promise<SignedExitIntent> {
  if (!wallet.publicKey || !wallet.connected) {
    throw new Error("Wallet not connected.");
  }
  if (!wallet.signMessage) {
    throw new Error(
      "This wallet does not support message signing. Try Phantom or Solflare.",
    );
  }
  const message = buildExitMessage(intent);
  const bytes = new TextEncoder().encode(message);
  const sigBytes = await wallet.signMessage(bytes);
  return { intent, message, signature: bytesToBase64(sigBytes) };
}
