import { useCallback, useEffect, useState } from "react";
import { api, type MarketDetail, type MarketSummary, type WireWithdrawal } from "../services/apiClient";

/**
 * Polls /api/markets every `intervalMs`. The server is the source of truth for
 * prices, volume, and status — the client just reflects what's there.
 */
export function useServerMarkets(intervalMs = 5_000): {
  markets: MarketSummary[];
  escrowAccount: string | null;
  /** v23: native SOL escrow address (= authority pubkey).  null until first poll. */
  escrowSolAccount: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [escrowAccount, setEscrowAccount] = useState<string | null>(null);
  const [escrowSolAccount, setEscrowSolAccount] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      try {
        const data = await api.listMarkets();
        if (cancelled) return;
        setMarkets(data.markets);
        setEscrowAccount(data.escrowAccount);
        if (data.escrowSolAccount) setEscrowSolAccount(data.escrowSolAccount);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load markets");
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(run, intervalMs);
        }
      }
    };
    run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { markets, escrowAccount, escrowSolAccount, loading, error, refresh };
}

/** Fetches a single market on a poll, with the embedded positions and trades. */
export function useServerMarket(
  marketId: string | undefined,
  intervalMs = 3_000,
): {
  market: MarketDetail | null;
  escrowAccount: string | null;
  /** v44: needed for the idempotent ATA-create instruction in TROLL deposits. */
  escrowSolAccount: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [market, setMarket] = useState<MarketDetail | null>(null);
  const [escrowAccount, setEscrowAccount] = useState<string | null>(null);
  const [escrowSolAccount, setEscrowSolAccount] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!marketId) {
      setMarket(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      try {
        const { market, escrowAccount, escrowSolAccount } = await api.getMarket(marketId);
        if (cancelled) return;
        setMarket(market);
        setEscrowAccount(escrowAccount);
        setEscrowSolAccount(escrowSolAccount ?? null);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load market");
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(run, intervalMs);
        }
      }
    };
    run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [marketId, intervalMs, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { market, escrowAccount, escrowSolAccount, loading, error, refresh };
}

/** A wallet's pending + sent + confirmed escrow_withdrawals across all markets. */
export function useUserWithdrawals(
  wallet: string | null,
  intervalMs = 8_000,
): {
  withdrawals: WireWithdrawal[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [withdrawals, setWithdrawals] = useState<WireWithdrawal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!wallet) {
      setWithdrawals([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      try {
        const { withdrawals } = await api.myWithdrawals(wallet);
        if (cancelled) return;
        setWithdrawals(withdrawals);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load withdrawals");
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(run, intervalMs);
        }
      }
    };
    run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [wallet, intervalMs, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { withdrawals, loading, error, refresh };
}
