import { useSolBalance, formatSolBalance } from "../hooks/useSolBalance";

/**
 * SOL balance pill for the connected-wallet header chip.
 *
 * v54.4 (wording cleanup): the secondary $TROLL pill was removed.  The
 * platform is SOL-only since v47, so showing a $TROLL balance next to the
 * SOL balance was clutter that suggested users could bet TROLL.  The
 * TrollBalancePill component still exists and is used on the /troll
 * archive page.
 *
 * If SOL is still loading the chip shows "loading…".  If the RPC errored
 * (e.g. VITE_HELIUS_RPC_URL not configured) it shows "—" so the layout
 * stays stable.
 *
 * Hidden on small viewports (< sm) to keep the header tight on mobile.
 */
export function WalletBalancesPill() {
  const sol = useSolBalance();

  return (
    <div className="hidden sm:flex items-center gap-1.5">
      <Chip
        loading={sol.loading}
        error={sol.error}
        text={sol.balance != null ? `${formatSolBalance(sol.balance)} SOL` : "— SOL"}
      />
    </div>
  );
}

function Chip({
  loading,
  error,
  text,
}: {
  loading: boolean;
  error: string | null;
  text: string;
}) {
  if (loading) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-cream-100/10 px-3 py-2 text-xs font-mono text-cream-100/70 ring-1 ring-cream-100/10"
        aria-live="polite"
      >
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-cyber-cyan" />
        loading…
      </span>
    );
  }
  if (error) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-cream-100/10 px-3 py-2 text-xs font-mono text-cream-100/60 ring-1 ring-cream-100/10"
        title={error}
      >
        {text}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-mono ring-1 ring-cream-100/10"
      style={{
        background:
          "linear-gradient(135deg, rgba(61,255,252,0.18) 0%, rgba(116,140,255,0.12) 100%)",
        color: "#F4ECDB",
      }}
    >
      <span aria-hidden className="text-cyber-cyan">
        ◇
      </span>
      <span className="tabular-nums">{text}</span>
    </span>
  );
}
