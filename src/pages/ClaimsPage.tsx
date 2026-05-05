import { Link } from "react-router-dom";
import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClaimablePayouts } from "../components/ClaimablePayouts";
import { useUserWithdrawals } from "../hooks/useServerMarkets";
import { WalletConnectButton } from "../components/WalletConnectButton";

/**
 * /claims — branded payouts page (v18, item 6).
 *
 * Replaces the prior single-list view with three distinct sections so the
 * user can scan their payouts at a glance:
 *
 *   - Claimable winnings  → settlement payouts (reason="payout") still pending
 *   - Refunds             → void refunds       (reason="refund") still pending
 *   - Settled history     → everything already confirmed (any reason)
 *
 * "exit" rows (early-exit refunds from selling on the AMM) live under
 * Refunds when pending and Settled history when confirmed — they're
 * conceptually money-back rather than money-won.
 *
 * Sections collapse cleanly when empty:
 *   - if all three are empty → render the spec's "No payouts yet" state
 *   - otherwise empty buckets are hidden (keep the page focused on what
 *     the user can act on right now)
 *
 * Disconnected → "Connect wallet to view payouts".
 * Loading      → "Payouts are syncing" (intentionally non-scary copy).
 * API error    → soft "Payouts are syncing" with the technical detail
 *                tucked under so the page never looks broken.
 */
export function ClaimsPage() {
  const { publicKey, connected } = useWallet();
  const walletAddr = publicKey?.toBase58() ?? null;
  const { withdrawals, loading, error, refresh } = useUserWithdrawals(walletAddr);

  // ---------- Group by status × reason — must be called unconditionally
  // so the hook order stays stable across renders (the disconnected return
  // below would otherwise short-circuit the hook list). --------------------
  const buckets = useMemo(() => {
    const claimable = withdrawals.filter(
      (w) => (w.status === "pending" || w.status === "sent") && w.reason === "payout",
    );
    const refunds = withdrawals.filter(
      (w) =>
        (w.status === "pending" || w.status === "sent") &&
        (w.reason === "refund" || w.reason === "exit"),
    );
    const history = withdrawals.filter((w) => w.status === "confirmed");
    return { claimable, refunds, history };
  }, [withdrawals]);

  // ---------- Disconnected state ----------------------------------------
  if (!connected || !walletAddr) {
    return (
      <main className="relative min-h-screen px-4 pb-32 pt-28 sm:px-8 sm:pt-32">
        <div className="mx-auto max-w-md glass rounded-3xl p-8 shadow-glass ring-1 ring-cream-100/10">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-yes">
            <span aria-hidden className="mr-1.5">▲</span>
            Payouts
          </p>
          <h1 className="mt-2 font-display text-2xl font-bold text-cream-100">
            Connect wallet to view payouts
          </h1>
          <p className="mt-2 text-sm text-cream-100/70">
            Settled positions and void refunds queue here once your wallet is connected.
          </p>
          <div className="mt-5">
            <WalletConnectButton />
          </div>
          <Link
            to="/"
            className="mt-6 inline-block text-xs text-cream-100/60 hover:text-yes"
          >
            ← Home
          </Link>
        </div>
      </main>
    );
  }

  const totalCounted =
    buckets.claimable.length + buckets.refunds.length + buckets.history.length;
  const allEmpty = !loading && !error && totalCounted === 0;

  return (
    <main className="relative min-h-screen px-4 pb-32 pt-28 sm:px-8 sm:pt-32">
      <div className="mx-auto max-w-[920px]">
        {/* ---------- Header ---------- */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-yes">
              <span aria-hidden className="mr-1.5">▲</span>
              Payouts
            </p>
            <h1 className="mt-1 font-display text-3xl font-bold tracking-tightest text-cream-100 sm:text-4xl">
              Your $TROLL claims
            </h1>
            <p className="mt-1 font-mono text-xs text-cream-100/55">
              {buckets.claimable.length} claimable ·{" "}
              {buckets.refunds.length} refunds ·{" "}
              {buckets.history.length} settled
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refresh}
              className="rounded-full bg-cream-100/8 px-3 py-2 text-xs text-cream-100 ring-1 ring-cream-100/15 hover:bg-cream-100/15"
            >
              Refresh
            </button>
            <Link
              to="/"
              className="rounded-full bg-cream-100/8 px-3 py-2 text-xs text-cream-100 ring-1 ring-cream-100/15 hover:bg-cream-100/15"
            >
              ← Home
            </Link>
          </div>
        </div>

        {/* ---------- Soft sync banner (replaces error toast) ----------
            req 6: "If API data is unavailable, show a clean non-scary
            state: 'Payouts are syncing'."  We surface the technical
            detail under it so debugging is still possible without
            showing a red error toast as the page's main content. */}
        {(loading || error) && (
          <div className="mt-5 rounded-2xl glass-dark px-4 py-3 ring-1 ring-cream-100/10">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-yes">
              {error ? "Payouts are syncing" : "Loading"}
            </p>
            <p className="mt-1 text-sm text-cream-100/75">
              {error
                ? "Latest entries will appear here once the next sync completes."
                : "Reading the latest escrow withdrawals for your wallet…"}
            </p>
            {error && (
              <p className="mt-1 font-mono text-[10px] text-cream-100/40">{error}</p>
            )}
          </div>
        )}

        {/* ---------- Empty state ---------- */}
        {allEmpty && (
          <div className="mt-6 glass rounded-3xl p-8 shadow-glass ring-1 ring-cream-100/10 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-yes">
              <span aria-hidden className="mr-1.5">▲</span>
              No payouts yet
            </p>
            <h2 className="mt-2 font-display text-xl font-bold text-cream-100">
              Winning predictions and void refunds will appear here.
            </h2>
            <p className="mt-2 text-sm text-cream-100/70">
              Make a prediction on the home page to get started.
            </p>
            <Link
              to="/"
              className="mt-5 inline-block rounded-full bg-yes px-4 py-2 text-xs font-mono uppercase tracking-wider text-ink-200 ring-1 ring-yes/40 hover:shadow-yes-glow"
            >
              Go predict
            </Link>
          </div>
        )}

        {/* ---------- Sections ---------- */}
        {!allEmpty && (
          <div className="mt-6 space-y-8">
            {buckets.claimable.length > 0 && (
              <Section
                eyebrow="Claimable winnings"
                accent="yes"
                count={buckets.claimable.length}
              >
                <ClaimablePayouts
                  withdrawals={buckets.claimable}
                  connectedWallet={walletAddr}
                  onClaimed={refresh}
                  buttonLabel="Claim"
                />
              </Section>
            )}
            {buckets.refunds.length > 0 && (
              <Section
                eyebrow="Refunds"
                accent="no"
                count={buckets.refunds.length}
              >
                <ClaimablePayouts
                  withdrawals={buckets.refunds}
                  connectedWallet={walletAddr}
                  onClaimed={refresh}
                  buttonLabel="Refund"
                />
              </Section>
            )}
            {buckets.history.length > 0 && (
              <Section
                eyebrow="Settled history"
                accent="muted"
                count={buckets.history.length}
              >
                <ClaimablePayouts
                  withdrawals={buckets.history}
                  connectedWallet={walletAddr}
                  onClaimed={refresh}
                />
              </Section>
            )}
          </div>
        )}

        <p className="mt-8 text-[11px] text-cream-100/50">
          Pending = the escrow row is queued; claim sends it now. Sent =
          transaction broadcast, awaiting confirmation. Confirmed =
          $TROLL is in your wallet (Solscan link).
        </p>
      </div>
    </main>
  );
}

function Section({
  eyebrow,
  accent,
  count,
  children,
}: {
  eyebrow: string;
  accent: "yes" | "no" | "muted";
  count: number;
  children: React.ReactNode;
}) {
  const accentCls =
    accent === "yes"
      ? "text-yes"
      : accent === "no"
        ? "text-no"
        : "text-cream-100/55";
  const dot =
    accent === "yes"
      ? "bg-yes shadow-yes-glow"
      : accent === "no"
        ? "bg-no shadow-no-glow"
        : "bg-cream-100/40";
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
        <p className={`font-mono text-[11px] uppercase tracking-[0.22em] ${accentCls}`}>
          {eyebrow}
        </p>
        <span className="font-mono text-[11px] text-cream-100/40">· {count}</span>
      </div>
      {children}
    </section>
  );
}
