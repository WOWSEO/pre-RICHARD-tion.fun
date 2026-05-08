import { useCallback, useEffect, useMemo, useState } from "react";
import type { MarketSummary, UserPositionRow } from "../services/apiClient";
import { api } from "../services/apiClient";

/**
 * v42 — open positions panel.  Lists every open position the connected
 * wallet has across all schedules, with cost basis, current value (from
 * the live AMM price in the market list), and P/L.
 *
 * Current-value math:
 *   YES position value = shares × yesPriceCents / 100
 *   NO  position value = shares × noPriceCents  / 100
 *   P/L                = current_value − cost_basis_troll
 *
 * Units are SOL for both cost basis and value (since v47 SOL-only).  The
 * schema column `cost_basis_troll` keeps its legacy name — the values it
 * holds are SOL units.  Renaming the column would require a migration with
 * no user-visible benefit.
 */
interface MyPositionsProps {
  walletAddress: string | null;
  /** Live market list — used to look up current yes/no prices per position. */
  markets: MarketSummary[];
  /** Bumped by parent whenever a new entry is signed → triggers a refetch. */
  refetchKey: number;
}

interface Enriched {
  row: UserPositionRow;
  market: MarketSummary | null;
  shares: number;
  costBasis: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
}

export function MyPositions({ walletAddress, markets, refetchKey }: MyPositionsProps) {
  const [rows, setRows] = useState<UserPositionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const refresh = useCallback(async () => {
    if (!walletAddress) {
      setRows([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await api.myPositions(walletAddress);
      setRows(r.positions ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  // Fetch on mount, on wallet change, on entry-signed bump, and every 30s.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh, refetchKey]);

  const enriched: Enriched[] = useMemo(() => {
    const byId = new Map(markets.map((m) => [m.id, m]));
    return rows
      .filter((r) => r.status === "open")
      .map((row) => {
        const market = byId.get(row.market_id) ?? null;
        const shares = Number(row.shares);
        const costBasis = Number(row.cost_basis_troll);
        const priceCents =
          row.side === "YES"
            ? market?.yesPriceCents ?? 50
            : market?.noPriceCents ?? 50;
        const currentValue = shares * (priceCents / 100);
        const pnl = currentValue - costBasis;
        const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
        return { row, market, shares, costBasis, currentValue, pnl, pnlPct };
      })
      .sort((a, b) => (a.market?.closeAt ?? "").localeCompare(b.market?.closeAt ?? ""));
  }, [rows, markets]);

  if (!walletAddress) return null;

  const totalCostBasis = enriched.reduce((s, e) => s + e.costBasis, 0);
  const totalValue = enriched.reduce((s, e) => s + e.currentValue, 0);
  const totalPnl = totalValue - totalCostBasis;

  return (
    <section className="my-positions">
      <header className="my-positions-head">
        <button
          type="button"
          className="my-positions-toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          <span>Your positions</span>
          <small>
            {enriched.length} open
            {enriched.length > 0 && (
              <>
                {" · "}
                <b className={totalPnl >= 0 ? "pnl-up" : "pnl-down"}>
                  {totalPnl >= 0 ? "+" : ""}
                  {totalPnl.toFixed(3)} SOL
                </b>
              </>
            )}
          </small>
          <span className="my-positions-caret">{collapsed ? "▸" : "▾"}</span>
        </button>
      </header>

      {!collapsed && (
        <div className="my-positions-body">
          {loading && rows.length === 0 && <p className="my-positions-empty">Loading…</p>}
          {error && (
            <p className="my-positions-empty my-positions-error">
              Couldn't load positions: {error}
            </p>
          )}
          {!loading && !error && enriched.length === 0 && (
            <p className="my-positions-empty">
              No open positions. Pick a market above to place your first bet.
            </p>
          )}
          {enriched.length > 0 && (
            <ul className="my-positions-list">
              {enriched.map((e) => (
                <li key={e.row.id} className="my-position-row">
                  <div className="my-position-meta">
                    <span className={`my-position-side side-${e.row.side.toLowerCase()}`}>
                      {e.row.side}
                    </span>
                    <span className="my-position-market">
                      {e.market?.symbol ? `${e.market.symbol} · ` : ""}
                      {e.market?.scheduleType === "15m"
                        ? "15-minute"
                        : e.market?.scheduleType === "hourly"
                          ? "Hourly"
                          : e.market?.scheduleType === "daily"
                            ? "Daily"
                            : "Market"}{" "}
                      · target ${(e.market?.targetMc ?? 0).toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <div className="my-position-numbers">
                    <span title="Cost basis">
                      In: <b>{e.costBasis.toFixed(2)}</b>
                    </span>
                    <span title="Current value at live AMM price">
                      Now: <b>{e.currentValue.toFixed(2)}</b>
                    </span>
                    <span
                      className={e.pnl >= 0 ? "pnl-up" : "pnl-down"}
                      title="Unrealized P/L"
                    >
                      {e.pnl >= 0 ? "+" : ""}
                      {e.pnl.toFixed(2)} ({e.pnlPct >= 0 ? "+" : ""}
                      {e.pnlPct.toFixed(1)}%)
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
