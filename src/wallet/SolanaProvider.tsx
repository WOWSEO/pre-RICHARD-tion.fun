import { useMemo, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";

/**
 * Wraps the app in Solana wallet context.
 *
 * We rely on the **Solana Wallet Standard** to auto-discover modern wallets that
 * inject themselves on page load — this includes Phantom and Backpack as of 2024.
 * We pass an explicit Solflare adapter for older injection support.
 *
 * RPC endpoint:
 *   - VITE_HELIUS_RPC_URL if set (use a paid endpoint in production)
 *   - falls back to mainnet-beta public cluster
 */
export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => {
    const fromEnv = import.meta.env.VITE_HELIUS_RPC_URL?.trim();
    if (fromEnv) return fromEnv;
    return clusterApiUrl("mainnet-beta");
  }, []);

  // The Solflare adapter is the only one we still hard-include — Phantom and Backpack
  // self-register via wallet-standard when their browser extensions are present.
  const wallets = useMemo(() => [new SolflareWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
