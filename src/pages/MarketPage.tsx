import { Link, useParams } from "react-router-dom";
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useServerMarket, useUserWithdrawals } from "../hooks/useServerMarkets";
import { PredictPanel } from "../components/PredictPanel";
import { useCountdown } from "../hooks/useCountdown";
import { formatMC } from "../services/marketData";
import { ClaimablePayouts } from "../components/ClaimablePayouts";
import { api, type WirePosition, type MarketDetail } from "../services/apiClient";

export function MarketPage() {
  const { marketId } = useParams<{ marketId: string }>();
  const wallet = useWallet();
  const walletAddr = wallet.publicKey?.toBase58() ?? null;

  const { market, escrowAccount, loading, error, refresh } = useServerMarket(marketId);
  const { withdrawals, refresh: refreshWithdrawals } = useUserWithdrawals(walletAddr);

  // Countdown must be called unconditionally
  const closeTime = market ? new Date(market.closeAt) : new Date();
  const { hh, mm, ss, expired } = useCountdown(closeTime);

  if (!market && loading) {
    return (
      <main className="relative min-h-screen px-4 pt-32 sm:px-8">
        <p className="mx-auto max-w-2xl text-center text-cream-100/60">Loading market…</p>
      </main>
    );
  }

  if (!market) {
    return (
      <main className="relative min-h-screen px-4 pt-32 sm:px-8">
        <div className="mx-auto max-w-2xl glass rounded-3xl p-10 text-center">
          <h1 className="font-display text-2xl font-bold text-ink-200">Market not found</h1>
          <p className="mt-2 text-sm text-ink-100">
            {error ?? `The market id "${marketId}" doesn't exist on the server.`}
          </p>
          <Link
            to="/troll"
            className="mt-5 inline-flex items-center gap-2 rounded-full bg-ink-200 px-5 py-2.5 text-sm font-semibold text-yes ring-1 ring-yes/40 hover:shadow-yes-glow"
          >
            ← Back to markets
          </Link>
        </div>
      </main>
    );
  }

  const myPositions = walletAddr
    ? market.positions.filter((p) => p.wallet === walletAddr && p.shares > 0)
    : [];

  return (
    <main className="relative min-h-screen px-4 pb-24 pt-28 sm:px-8 sm:pt-32">
      <div className="mx-auto max-w-[1280px]">
        <Link to="/troll" className="inline-flex items-center gap-1.5 text-xs text-cream-100/60 hover:text-yes">
          ← All markets
        </Link>

        <div className="mt-4 grid gap-8 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-cream-100/60">
              {scheduleLabel(market.scheduleType)}
            </p>
            <h1 className="mt-2 font-display text-3xl font-bold leading-tight tracking-tightest text-cream-100 text-balance sm:text-4xl">
              Will $TROLL be over{" "}
              <span className="bg-yes/30 px-2 rounded">{formatMC(market.targetMc)}</span> MC at{" "}
              <span className="font-mono">
                {new Date(market.closeAt).toLocaleString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                  weekday: "short",
                })}
              </span>
              ?
            </h1>

            {/* Price grid */}
            <div className="mt-6 grid grid-cols-2 gap-4">
              <BigPrice side="YES" cents={market.yesPriceCents} />
              <BigPrice side="NO" cents={market.noPriceCents} />
            </div>

            {/* Stats strip */}
            <div className="mt-4 grid grid-cols-3 gap-3 rounded-2xl glass-dark p-4 ring-1 ring-cream-100/10">
              <Stat label="Locks in" value={expired ? "—" : `${hh}:${mm}:${ss}`} mono />
              <Stat label="Volume" value={market.volume.toFixed(0)} suffix="$TROLL" />
              <Stat label="Open Interest" value={market.openInterest.toFixed(0)} suffix="$TROLL" />
              <Stat label="qYES" value={market.yesLiquidity.toFixed(0)} mono />
              <Stat label="qNO" value={market.noLiquidity.toFixed(0)} mono />
              <Stat label="Status" value={market.status} mono uppercase />
            </div>

            {/* User positions */}
            {wallet.connected && (
              <div className="mt-8">
                <h2 className="font-display text-xl font-bold tracking-tightest text-cream-100">
                  Your positions
                </h2>
                {myPositions.length === 0 ? (
                  <p className="mt-2 text-sm text-cream-100/60">
                    No open positions in this market yet.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {myPositions.map((p) => (
                      <PositionRow
                        key={p.id}
                        position={p}
                        market={market}
                        onExited={() => {
                          refresh();
                          refreshWithdrawals();
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Claimable payouts for THIS market */}
            {wallet.connected && walletAddr && (
              <div className="mt-8">
                <h2 className="font-display text-xl font-bold tracking-tightest text-cream-100">
                  Payouts & refunds
                </h2>
                <div className="mt-3">
                  <ClaimablePayouts
                    withdrawals={withdrawals}
                    filterMarketId={market.id}
                    connectedWallet={walletAddr}
                    onClaimed={() => refreshWithdrawals()}
                    emptyHint="No exits, payouts, or refunds for this market yet."
                  />
                </div>
              </div>
            )}

            {/* Audit footer */}
            <div className="mt-8 flex items-center gap-2.5 text-xs text-cream-100/60">
              <span aria-hidden>⛨</span>
              <span>
                Settles by median MC across DexScreener + GeckoTerminal —{" "}
                <Link to={`/audit/${market.id}`} className="text-yes hover:underline">
                  see audit receipt →
                </Link>
              </span>
            </div>
          </div>

          {/* Predict panel */}
          <div className="lg:col-span-5">
            <PredictPanel
              market={market}
              escrowAccount={escrowAccount}
              onTradeCommitted={() => {
                refresh();
                refreshWithdrawals();
              }}
            />
          </div>
        </div>
      </div>
    </main>
  );
}

/* ========================================================================== */

function scheduleLabel(s: MarketDetail["scheduleType"]): string {
  if (s === "15m") return "15-minute market";
  if (s === "hourly") return "Hourly market";
  return "Daily 7PM ET market";
}

function BigPrice({ side, cents }: { side: "YES" | "NO"; cents: number }) {
  const isYes = side === "YES";
  return (
    <div
      className={`relative overflow-hidden rounded-2xl p-5 ring-1 ${
        isYes ? "bg-yes/15 ring-yes/40" : "bg-no/15 ring-no/40"
      }`}
    >
      <p className={`font-mono text-[10px] uppercase tracking-[0.18em] ${isYes ? "text-yes-deep" : "text-no-deep"}`}>
        {side} · {isYes ? "Over" : "Under"}
      </p>
      <p className={`mt-2 font-display text-5xl font-bold tabular-nums ${isYes ? "text-yes-deep" : "text-no-deep"}`}>
        {cents.toFixed(1)}
        <span className="text-2xl">¢</span>
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  suffix,
  mono,
  uppercase,
}: {
  label: string;
  value: string;
  suffix?: string;
  mono?: boolean;
  uppercase?: boolean;
}) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-cream-100/50">{label}</p>
      <p
        className={`mt-1 text-sm font-semibold tabular-nums text-cream-100 ${
          mono ? "font-mono" : "font-display"
        } ${uppercase ? "uppercase" : ""}`}
      >
        {value}
        {suffix && <span className="ml-1 text-[10px] font-normal text-cream-100/50">{suffix}</span>}
      </p>
    </div>
  );
}

function PositionRow({
  position,
  market,
  onExited,
}: {
  position: WirePosition;
  market: MarketDetail;
  onExited: () => void;
}) {
  const wallet = useWallet();
  const [exiting, setExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isYes = position.side === "YES";
  // v17: tradable while status === "open" AND now < closeAt.  No lockAt gating.
  const tradable = market.status === "open" && new Date(market.closeAt) > new Date();
  const currentPriceCents = isYes ? market.yesPriceCents : market.noPriceCents;
  const markValue = (position.shares * currentPriceCents) / 100;
  const unreal = markValue - position.costBasisTroll;
  const pnlClass = unreal >= 0 ? "text-yes-deep" : "text-no-deep";

  const onExit = async () => {
    if (!wallet.publicKey) return;
    setExiting(true);
    setError(null);
    try {
      await api.exit(position.id, { wallet: wallet.publicKey.toBase58() });
      onExited();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Exit failed");
    } finally {
      setExiting(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl glass-dark p-4 ring-1 ring-cream-100/10">
      <div className="flex items-center gap-3">
        <span
          className={`grid h-9 w-9 place-items-center rounded-full font-mono text-[10px] font-bold ${
            isYes ? "bg-yes/30 text-yes-deep" : "bg-no/30 text-no-deep"
          }`}
        >
          {isYes ? "YES" : "NO"}
        </span>
        <div>
          <p className="font-mono text-xs text-cream-100">
            {position.shares.toFixed(2)} sh @ {position.averageEntryPriceCents.toFixed(2)}¢
          </p>
          <p className="text-[11px] text-cream-100/60">
            cost {position.costBasisTroll.toFixed(2)} $TROLL · mark {markValue.toFixed(2)} ·{" "}
            <span className={pnlClass}>
              {unreal >= 0 ? "+" : ""}
              {unreal.toFixed(2)}
            </span>
          </p>
          {error && <p className="mt-1 text-[11px] text-no-deep">⚠ {error}</p>}
        </div>
      </div>
      <button
        onClick={onExit}
        disabled={!tradable || exiting}
        title={
          !tradable
            ? "Trading is closed — payout will arrive at settlement"
            : exiting
              ? "Exiting…"
              : "Sell shares back to the AMM and queue a refund"
        }
        className="rounded-full bg-cream-100/10 px-3.5 py-1.5 text-[11px] font-mono uppercase tracking-wider text-cream-100 ring-1 ring-cream-100/15 transition hover:bg-cream-100/20 disabled:opacity-40"
      >
        {exiting ? "Exiting…" : tradable ? "Exit" : "Closed"}
      </button>
    </div>
  );
}
