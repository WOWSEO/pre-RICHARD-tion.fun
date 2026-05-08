import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type WireWithdrawal } from "../services/apiClient";
import { EscrowStatus } from "./EscrowStatus";
import { formatTrollBalance } from "../services/trollBalance";

/**
 * Lists every escrow_withdrawal for a wallet — pending, sent, confirmed.
 *
 * `buttonLabel` (v18, item 6) controls the action button copy:
 *   "Claim" for winnings, "Refund" for void/exit refunds.  Defaults to "Claim".
 *
 * `connectedWallet` (when supplied) enables the inline action button on every
 * `pending` row whose wallet matches.
 *
 * `onClaimed(id)` is invoked after a successful claim so the parent can refresh.
 */
export function ClaimablePayouts({
  withdrawals,
  filterMarketId,
  emptyHint,
  connectedWallet,
  onClaimed,
  buttonLabel = "Claim",
}: {
  withdrawals: WireWithdrawal[];
  filterMarketId?: string;
  emptyHint?: string;
  connectedWallet?: string | null;
  onClaimed?: (id: number) => void;
  buttonLabel?: "Claim" | "Refund";
}) {
  const rows = useMemo(() => {
    const filtered = filterMarketId
      ? withdrawals.filter((w) => w.market_id === filterMarketId)
      : withdrawals;
    return filtered;
  }, [withdrawals, filterMarketId]);

  const [busyId, setBusyId] = useState<number | null>(null);
  const [errorById, setErrorById] = useState<Record<number, string>>({});

  const onClaim = async (w: WireWithdrawal) => {
    if (!connectedWallet) return;
    if (w.wallet !== connectedWallet) return;
    if (w.status !== "pending") return;
    setBusyId(w.id);
    setErrorById((prev) => {
      const next = { ...prev };
      delete next[w.id];
      return next;
    });
    try {
      console.info(`[claim] requesting id=${w.id} wallet=${connectedWallet}`);
      const r = await api.claimWithdrawal(w.id, connectedWallet);
      console.info(`[claim] response id=${w.id} status=${r.status} sig=${r.signature ?? "n/a"}`);
      if (onClaimed) onClaimed(w.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "claim_failed";
      console.warn(`[claim] error id=${w.id} reason=${msg}`);
      setErrorById((prev) => ({ ...prev, [w.id]: msg }));
    } finally {
      setBusyId(null);
    }
  };

  if (rows.length === 0) {
    return (
      <p className="text-sm text-cream-100/55">
        {emptyHint ?? "No pending or claimable payouts."}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((w) => {
        const amount = Number.parseFloat(w.amount_troll);
        const reasonLabel: Record<typeof w.reason, string> = {
          exit: "Exit proceeds",
          payout: "Settlement payout",
          refund: "Void refund",
        };
        const isOwner = !!connectedWallet && w.wallet === connectedWallet;
        const showClaim = isOwner && w.status === "pending";
        const isBusy = busyId === w.id;
        const claimError = errorById[w.id];
        const busyLabel = buttonLabel === "Refund" ? "Refunding…" : "Claiming…";
        return (
          <div
            key={w.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl glass-dark p-3.5 ring-1 ring-cream-100/10"
          >
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-cream-100/55">
                {reasonLabel[w.reason]} ·{" "}
                <span className="text-cream-100/70">
                  {filterMarketId ? "" : `${w.market_id} · `}
                </span>
                {new Date(w.created_at).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </p>
              <p className="mt-0.5 font-display text-lg font-bold tabular-nums text-cream-100">
                {formatTrollBalance(amount)}{" "}
                <span className="text-xs font-medium text-cream-100/60">SOL</span>
              </p>
              {w.failure_reason && (
                <p className="mt-1 text-[11px] text-no-deep">⚠ {w.failure_reason}</p>
              )}
              {claimError && (
                <p className="mt-1 text-[11px] text-no-deep">⚠ {claimError}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <EscrowStatus
                kind={w.status}
                signature={w.signature}
                reason={w.failure_reason}
              />
              {/* v18 item 6 — "View market" link on every row when not
                  scoped to a single market.  Lets users audit each row. */}
              {!filterMarketId && (
                <Link
                  to={`/market/${w.market_id}`}
                  className="rounded-full bg-cream-100/8 px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider text-cream-100 ring-1 ring-cream-100/15 transition hover:bg-cream-100/15"
                >
                  View market
                </Link>
              )}
              {showClaim && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => onClaim(w)}
                  className={`rounded-full px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider text-ink-200 ring-1 transition disabled:opacity-50 disabled:cursor-not-allowed ${
                    buttonLabel === "Refund"
                      ? "bg-no ring-no/40 hover:shadow-no-glow"
                      : "bg-yes ring-yes/40 hover:shadow-yes-glow"
                  }`}
                >
                  {isBusy ? busyLabel : buttonLabel}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
