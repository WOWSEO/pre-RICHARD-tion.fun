import { Link } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClaimablePayouts } from "../components/ClaimablePayouts";
import { useUserWithdrawals } from "../hooks/useServerMarkets";
import { WalletConnectButton } from "../components/WalletConnectButton";

/**
 * /claims — one place to see every escrow_withdrawal for the connected wallet
 * (pending, sent, confirmed) and click Claim on any pending row.
 *
 * Reachable from the landing-page nav's "Payouts" pill (only shown when
 * connected).  Per-market views still use the same ClaimablePayouts component
 * filtered by marketId; this page is the global cross-market view.
 *
 * Lifecycle:
 *   - settle queues escrow_withdrawals rows with status='pending'
 *   - any of {user clicks Claim, npm run payouts:run cron, admin runs
 *     /api/admin/payouts/run} can transition pending → sent → confirmed
 *   - all three paths share the same atomic CAS in sendWithdrawal so they
 *     never double-spend
 */
export function ClaimsPage() {
  const { publicKey, connected } = useWallet();
  const walletAddr = publicKey?.toBase58() ?? null;
  const { withdrawals, loading, error, refresh } = useUserWithdrawals(walletAddr);

  if (!connected || !walletAddr) {
    return (
      <main className="relative min-h-screen px-4 pb-32 pt-28 sm:px-8 sm:pt-32">
        <div className="mx-auto max-w-md glass rounded-3xl p-8 shadow-glass">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-100/60">
            Payouts
          </p>
          <h1 className="mt-2 font-display text-2xl font-bold text-ink-200">
            Connect to view payouts
          </h1>
          <p className="mt-2 text-sm text-ink-100/70">
            Settled positions queue an escrow withdrawal you can claim from this page.
          </p>
          <div className="mt-4">
            <WalletConnectButton />
          </div>
          <Link to="/" className="mt-4 inline-block text-xs text-ink-100/60 hover:text-yes">
            ← Home
          </Link>
        </div>
      </main>
    );
  }

  const pending = withdrawals.filter((w) => w.status === "pending").length;
  const inFlight = withdrawals.filter((w) => w.status === "sent").length;
  const confirmed = withdrawals.filter((w) => w.status === "confirmed").length;

  return (
    <main className="relative min-h-screen px-4 pb-32 pt-28 sm:px-8 sm:pt-32">
      <div className="mx-auto max-w-[920px]">
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
              {pending} pending · {inFlight} in-flight · {confirmed} confirmed
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

        {error && (
          <p className="mt-5 rounded-2xl bg-no/15 px-4 py-3 text-sm text-no-deep ring-1 ring-no/30">
            ⚠ {error}
          </p>
        )}

        <section className="mt-6">
          {loading && withdrawals.length === 0 ? (
            <p className="text-sm text-cream-100/55">Loading…</p>
          ) : (
            <ClaimablePayouts
              withdrawals={withdrawals}
              connectedWallet={walletAddr}
              onClaimed={() => {
                refresh();
              }}
              emptyHint="No payouts yet. Settled or voided positions will appear here as claimable rows."
            />
          )}
        </section>

        <p className="mt-8 text-[11px] text-cream-100/50">
          Pending = the escrow row is queued; claim sends it now. Sent = transaction broadcast,
          awaiting confirmation. Confirmed = $TROLL is in your wallet (Solscan link).
        </p>
      </div>
    </main>
  );
}
