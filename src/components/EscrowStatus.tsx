/**
 * Visual status badge for an on-chain escrow record (deposit OR withdrawal).
 *
 * Used inline on positions and on the claimable-payouts list.
 */
export type EscrowKind =
  | "pending"      // deposit submitted, not yet confirmed; OR withdrawal queued, not yet sent
  | "sent"         // withdrawal broadcast, not yet confirmed
  | "confirmed"    // deposit verified on-chain; OR payout confirmed
  | "failed";      // verification rejected, or payout error

export function EscrowStatus({
  kind,
  signature,
  reason,
  short = false,
}: {
  kind: EscrowKind;
  signature?: string | null;
  reason?: string | null;
  short?: boolean;
}) {
  const map: Record<EscrowKind, { label: string; cls: string; dot: string }> = {
    pending: {
      label: "Pending",
      cls: "bg-cyber-cyan/15 text-ink-200 ring-cyber-cyan/30",
      dot: "bg-cyber-cyan",
    },
    sent: {
      label: "Sent",
      cls: "bg-cyber-amber/15 text-ink-200 ring-cyber-amber/30",
      dot: "bg-cyber-amber",
    },
    confirmed: {
      label: "Confirmed",
      cls: "bg-yes/15 text-yes-deep ring-yes/30",
      dot: "bg-yes",
    },
    failed: {
      label: "Failed",
      cls: "bg-no/15 text-no-deep ring-no/30",
      dot: "bg-no",
    },
  };
  const m = map[kind];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.14em] ring-1 ${m.cls}`}
      title={reason ?? undefined}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${m.dot} ${kind === "pending" || kind === "sent" ? "animate-pulse" : ""}`} aria-hidden />
      {m.label}
      {!short && signature && (
        <a
          href={`https://solscan.io/tx/${signature}`}
          target="_blank"
          rel="noreferrer noopener"
          className="ml-0.5 underline-offset-2 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          ↗
        </a>
      )}
    </span>
  );
}
