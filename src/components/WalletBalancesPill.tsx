import { useTrollBalance } from "../hooks/useTrollBalance";
import { useSolBalance, formatSolBalance } from "../hooks/useSolBalance";
import { formatTrollBalance } from "../services/trollBalance";

/**
 * Combined SOL + $TROLL balance pill.
 *
 * Renders two stacked chips next to the wallet-address button when
 * connected:
 *   - SOL: native lamports / 1e9, brand-cyan tint
 *   - $TROLL: SPL balance, brand-green/cyan gradient (matches old pill)
 *
 * If a balance is still loading, that one chip shows "loading…".  If it
 * errored out (RPC flake, mint not configured), it shows "—" so the
 * layout stays stable.  Both chips are independent — one failing
 * doesn't hide the other.
 *
 * Hidden on small viewports (< sm) to keep the header tight on mobile;
 * the same balances are surfaced inside the predict panel anyway.
 */
export function WalletBalancesPill() {
  const sol = useSolBalance();
  const troll = useTrollBalance();

  return (
    <div className="hidden sm:flex items-center gap-1.5">
      <Chip
        kind="sol"
        loading={sol.loading}
        error={sol.error}
        text={sol.balance != null ? `${formatSolBalance(sol.balance)} SOL` : "— SOL"}
      />
      <Chip
        kind="troll"
        loading={troll.loading}
        error={troll.error}
        text={troll.balance != null ? `${formatTrollBalance(troll.balance)} $TROLL` : "— $TROLL"}
        empty={troll.balance === 0}
      />
    </div>
  );
}

function Chip({
  kind,
  loading,
  error,
  text,
  empty = false,
}: {
  kind: "sol" | "troll";
  loading: boolean;
  error: string | null;
  text: string;
  empty?: boolean;
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
  // Brand styling per kind.  SOL = cool cyan/violet gradient; TROLL =
  // green/cyan gradient (preserved exactly from the old TrollBalancePill).
  const style =
    kind === "sol"
      ? {
          background:
            "linear-gradient(135deg, rgba(61,255,252,0.18) 0%, rgba(116,140,255,0.12) 100%)",
          color: "#F4ECDB",
        }
      : {
          background:
            "linear-gradient(135deg, rgba(116,255,61,0.18) 0%, rgba(61,255,252,0.12) 100%)",
          color: "#F4ECDB",
        };
  const dotCls = kind === "sol" ? "text-cyber-cyan" : "text-yes";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-mono ring-1 ring-cream-100/10"
      style={style}
    >
      <span aria-hidden className={dotCls}>
        ◇
      </span>
      <span className="tabular-nums">{text}</span>
      {empty && (
        <span className="ml-0.5 rounded bg-cream-100/10 px-1 text-[9px] uppercase tracking-wider text-cream-100/60">
          empty
        </span>
      )}
    </span>
  );
}
