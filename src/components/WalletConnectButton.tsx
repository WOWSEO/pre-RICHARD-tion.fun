import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { TrollBalancePill } from "./TrollBalancePill";
import { shortenAddress } from "../services/trollBalance";

/**
 * Custom-styled wallet connect/disconnect button.
 *
 * - Disconnected: pill button "Connect Wallet" → opens the wallet-adapter modal,
 *   which lists every wallet currently injected via the Solana Wallet Standard
 *   (Phantom, Backpack, etc) plus our explicitly-included Solflare adapter.
 * - Connected:    address pill + live $TROLL balance, click ✕ to disconnect.
 *
 * We deliberately DO NOT use `useWalletMultiButton`. That hook lives in the
 * separate `@solana/wallet-adapter-base-ui` package and would add another
 * dependency for state we already get from `useWallet()`.
 */
export function WalletConnectButton() {
  const { setVisible } = useWalletModal();
  const { publicKey, connected, connecting, disconnecting, disconnect, wallet, connect } = useWallet();

  const onClick = useCallback(async () => {
    if (connected) {
      try {
        await disconnect();
      } catch {
        /* swallow — user cancelling disconnect is fine */
      }
      return;
    }
    if (wallet) {
      // A wallet was selected previously but we're not connected. Try connecting.
      try {
        await connect();
      } catch {
        // Selected wallet refused; fall through to letting the user pick another.
        setVisible(true);
      }
      return;
    }
    setVisible(true);
  }, [connected, wallet, connect, disconnect, setVisible]);

  if (connected && publicKey) {
    const addr = publicKey.toBase58();
    return (
      <div className="flex items-center gap-1.5">
        <TrollBalancePill />
        <button
          onClick={onClick}
          className="group inline-flex items-center gap-2 rounded-full bg-ink-200/80 px-3 py-2 text-xs font-mono text-cream-100 ring-1 ring-cream-100/15 backdrop-blur-md transition hover:ring-no/60"
          title="Disconnect wallet"
          aria-label={`Connected as ${addr}, click to disconnect`}
        >
          <span
            className="inline-block h-2 w-2 rounded-full bg-yes"
            style={{ boxShadow: "0 0 10px rgba(116,255,61,0.8)" }}
            aria-hidden
          />
          <span className="tabular-nums">{shortenAddress(addr)}</span>
          <span className="text-cream-100/40 transition group-hover:text-no" aria-hidden>
            ✕
          </span>
        </button>
      </div>
    );
  }

  const label = connecting ? "Connecting…" : disconnecting ? "Disconnecting…" : "Connect Wallet";
  const disabled = connecting || disconnecting;

  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-full bg-yes px-4 py-2 text-xs font-semibold text-ink-200 ring-1 ring-yes/30 transition hover:bg-yes-glow hover:shadow-yes-glow disabled:opacity-60"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3" y="6" width="18" height="13" rx="2.5" stroke="currentColor" strokeWidth="2" />
        <path d="M16 12.5h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M3 9h13" stroke="currentColor" strokeWidth="2" />
      </svg>
      {label}
    </button>
  );
}
