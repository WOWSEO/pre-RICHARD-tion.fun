import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

interface State {
  /** Balance in SOL (not lamports).  Null when wallet is disconnected. */
  balance: number | null;
  loading: boolean;
  error: string | null;
}

/**
 * Live native-SOL balance for the connected wallet.
 *
 * Parallel API to `useTrollBalance` so the header pill can display both
 * SOL and $TROLL side by side.  Bumps `refreshKey` from the parent if you
 * need to force a re-read (e.g., after a tx settles).
 *
 * Returns lamports / 1e9 (i.e. SOL).  No formatting — that lives in the
 * pill component so callers can render at whatever precision they want.
 */
export function useSolBalance(refreshKey: number = 0): State {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const [state, setState] = useState<State>({ balance: null, loading: false, error: null });

  useEffect(() => {
    if (!connected || !publicKey) {
      setState({ balance: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    connection
      .getBalance(publicKey, "confirmed")
      .then((lamports) => {
        if (cancelled) return;
        setState({ balance: lamports / LAMPORTS_PER_SOL, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to read SOL balance";
        setState({ balance: null, loading: false, error: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [connected, publicKey, connection, refreshKey]);

  return state;
}

/**
 * Format SOL for display.  Shows up to 3 decimals for small balances and
 * trims trailing zeros for cleaner display ("1.5" not "1.500").
 */
export function formatSolBalance(amount: number): string {
  if (!Number.isFinite(amount)) return "0";
  if (amount === 0) return "0";
  // Below 0.001 SOL show "<0.001" rather than 0.0000…
  if (amount < 0.001) return "<0.001";
  // 3 decimals max, trim trailing zeros
  const fixed = amount.toFixed(3);
  return fixed.replace(/\.?0+$/, "");
}
