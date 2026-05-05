import { useEffect, useState } from "react";
import { getTrollMarketData, type TrollMarketData } from "../services/marketData";

interface State {
  data: TrollMarketData | null;
  loading: boolean;
}

/**
 * Polls live $TROLL data every `intervalMs`. Defaults to 15s — slow enough to
 * stay under DexScreener's 300/min budget, fast enough to feel live.
 */
export function useTrollMarketData(intervalMs: number = 15_000): State {
  const [state, setState] = useState<State>({ data: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const data = await getTrollMarketData();
        if (!cancelled) setState({ data, loading: false });
      } catch {
        if (!cancelled) setState((s) => ({ ...s, loading: false }));
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);

  return state;
}
