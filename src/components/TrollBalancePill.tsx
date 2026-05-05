import { useTrollBalance } from "../hooks/useTrollBalance";
import { formatTrollBalance } from "../services/trollBalance";

/**
 * Live $TROLL balance pill.
 *
 * Renders only when the wallet is connected (the hook returns null otherwise).
 * If the RPC read fails (e.g. VITE_TROLL_MINT not configured), shows "—" so
 * the layout stays stable.
 */
export function TrollBalancePill() {
  const { balance, loading, error } = useTrollBalance();

  if (loading) {
    return (
      <span
        className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-cream-100/10 px-3 py-2 text-xs font-mono text-cream-100/70 ring-1 ring-cream-100/10"
        aria-live="polite"
      >
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-cyber-cyan" />
        loading…
      </span>
    );
  }

  if (error || balance == null) {
    return (
      <span
        className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-cream-100/10 px-3 py-2 text-xs font-mono text-cream-100/60 ring-1 ring-cream-100/10"
        title={error ?? "TROLL mint not configured"}
      >
        — $TROLL
      </span>
    );
  }

  const isZero = balance === 0;
  return (
    <span
      className="hidden sm:inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-mono ring-1 ring-cream-100/10"
      style={{
        background: "linear-gradient(135deg, rgba(116,255,61,0.18) 0%, rgba(61,255,252,0.12) 100%)",
        color: "#F4ECDB",
      }}
    >
      <span aria-hidden className="text-yes">◇</span>
      <span className="tabular-nums">
        {formatTrollBalance(balance)}{" "}
        <span className="text-cream-100/60">$TROLL</span>
      </span>
      {isZero && (
        <span className="ml-0.5 rounded bg-cream-100/10 px-1 text-[9px] uppercase tracking-wider text-cream-100/60">
          empty
        </span>
      )}
    </span>
  );
}
