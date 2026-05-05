import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getTrollBalance } from "../services/trollBalance";

interface State {
  balance: number | null;
  loading: boolean;
  error: string | null;
}

export function useTrollBalance(refreshKey: number = 0): State {
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
    getTrollBalance(publicKey.toBase58(), { connection })
      .then((b) => {
        if (!cancelled) setState({ balance: b, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Failed to read balance";
          setState({ balance: null, loading: false, error: msg });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connected, publicKey, connection, refreshKey]);

  return state;
}
