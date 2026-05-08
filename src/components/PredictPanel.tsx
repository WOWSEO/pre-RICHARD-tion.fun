import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useNavigate } from "react-router-dom";
import { api } from "../services/apiClient";
import { depositToEscrow, getTrollDecimals } from "../services/escrow";
import { useTrollBalance } from "../hooks/useTrollBalance";
import { useCountdown } from "../hooks/useCountdown";
import { formatTrollBalance, shortenAddress } from "../services/trollBalance";
import type { Side, TradeQuote } from "../market/marketTypes";
import type { MarketDetail } from "../services/apiClient";
import { QuotePreview } from "./QuotePreview";

/**
 * Trade panel — REAL SOL escrow flow.
 *
 * 1. Quote: POST /api/markets/:id/quote → server runs brain quote, returns TradeQuote
 * 2. Confirm: client builds SPL transfer to escrow ATA → Phantom signs → broadcast
 * 3. Settle: POST /api/markets/:id/enter with the confirmed signature
 *    → server fetches the tx on-chain, verifies (source / dest / mint / amount),
 *    → only on success commits the position and trade
 *
 * If verification fails, the deposit row is marked 'failed' and no position is
 * created — the user can claim a refund via admin.
 */
type Phase =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "ready"; quote: TradeQuote }
  | { kind: "signing" }
  | { kind: "broadcasting" }
  | { kind: "verifying" }
  | { kind: "ok"; positionId: string }
  | { kind: "error"; message: string };

interface Props {
  market: MarketDetail;
  escrowAccount: string | null;
  /** v44: escrow authority pubkey, needed for idempotent ATA-create in deposits */
  escrowSolAccount: string | null;
  onTradeCommitted: () => void;
}

export function PredictPanel({ market, escrowAccount, escrowSolAccount, onTradeCommitted }: Props) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const balance = useTrollBalance();
  const navigate = useNavigate();
  // v17: countdown ticks toward closeAt (not lockAt).  Users keep predicting
  // until the moment of close, so the on-screen timer tracks the same
  // boundary the backend uses to gate entry.
  const closeAtDate = useMemo(() => new Date(market.closeAt), [market.closeAt]);
  const { hh, mm, ss, expired } = useCountdown(closeAtDate);

  const [side, setSide] = useState<Side>("YES");
  const [amountStr, setAmountStr] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Re-render every second so the under-60s "Closing soon" / past-closeAt
  // "Closed" copy updates without waiting for a market poll.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const amount = useMemo(() => {
    const n = parseFloat(amountStr);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [amountStr]);

  // ---------- UI states ----------------------------------------------------
  // v17 product rule: a market is enterable when status === "open" AND we
  // are STRICTLY before closeAt.  `lockAt` is no longer a behavioral cutoff
  // (kept on the wire only for backwards compat with older clients).
  const tradable = market.status === "open" && closeAtDate.getTime() > nowMs;
  // closingSoon — within the final 60s.  Header copy switches to "Closing
  // soon" so users notice without us blocking entry.
  const msUntilClose = closeAtDate.getTime() - nowMs;
  const closingSoon = tradable && msUntilClose > 0 && msUntilClose < 60_000;
  // awaitingFirstTrade — open + zero activity.  This is a normal state, not
  // an error (the YES/NO prices defaulting to 50¢/50¢ is correct here).
  const awaitingFirstTrade =
    tradable && market.volume === 0 && market.openInterest === 0;
  // v54.2 (wording cleanup): noTroll prompt removed — was checking TROLL SPL
  // balance and prompting the user to "add TROLL" even though the platform
  // is SOL-only since v47.  Insufficient-SOL is caught at submit time by the
  // server's quote/enter pipeline.  Variable preserved as `false` so the
  // existing references downstream don't need to change.
  const noTroll = false;

  // Auto-fetch quote whenever (side, amount) settles
  useEffect(() => {
    if (!tradable || amount <= 0) {
      setPhase({ kind: "idle" });
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setPhase({ kind: "quoting" });
      try {
        const { quote } = await api.quote(market.id, side, amount);
        if (!cancelled) setPhase({ kind: "ready", quote });
      } catch (err) {
        if (!cancelled) {
          setPhase({
            kind: "error",
            message: err instanceof Error ? err.message : "Quote failed",
          });
        }
      }
    }, 200); // debounce typing
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [market.id, side, amount, tradable]);

  const onMax = () => {
    if (balance.balance != null && balance.balance > 0) {
      setAmountStr(Math.floor(balance.balance).toString());
    }
  };

  const onConfirm = async () => {
    if (!wallet.connected || !wallet.publicKey) {
      setPhase({ kind: "error", message: "Connect your wallet first." });
      return;
    }
    if (!escrowAccount) {
      setPhase({ kind: "error", message: "Server hasn't reported an escrow account yet." });
      return;
    }
    if (!escrowSolAccount) {
      // v44 — needed for idempotent ATA-create instruction in deposit tx
      setPhase({ kind: "error", message: "Server hasn't reported an escrow authority yet. Try again in a moment." });
      return;
    }
    if (phase.kind !== "ready") return;
    if (!tradable) {
      setPhase({ kind: "error", message: "Market is closed." });
      return;
    }

    const mintStr = import.meta.env.VITE_TROLL_MINT?.trim();
    if (!mintStr) {
      setPhase({
        kind: "error",
        message: "VITE_TROLL_MINT is not configured. Set it in .env.",
      });
      return;
    }

    try {
      const trollMint = new PublicKey(mintStr);
      const escrowAta = new PublicKey(escrowAccount);
      const escrowAuthorityPk = new PublicKey(escrowSolAccount);

      setPhase({ kind: "signing" });
      const decimals = await getTrollDecimals(connection, trollMint);

      // Phantom signs + we broadcast + confirm.
      // From the user's perspective this whole step is "Sign SOL entry".
      setPhase({ kind: "broadcasting" });
      const signature = await depositToEscrow({
        wallet,
        connection,
        trollMint,
        escrowTokenAccount: escrowAta,
        escrowAuthority: escrowAuthorityPk,
        amountUi: amount,
        decimals,
      });

      // Server verifies the on-chain transfer THEN commits the position.
      setPhase({ kind: "verifying" });
      const result = await api.enter(market.id, {
        wallet: wallet.publicKey.toBase58(),
        side,
        amountTroll: amount,
        signature,
      });

      setPhase({ kind: "ok", positionId: result.positionId });
      setAmountStr("");
      onTradeCommitted();
      // brief pause so user sees the success state, then route them back
      setTimeout(() => navigate(`/market/${market.id}`), 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Confirm failed";
      setPhase({ kind: "error", message: msg });
    }
  };

  const insufficient =
    balance.balance != null && amount > 0 && amount > balance.balance && wallet.connected;

  return (
    <div className="glass relative overflow-hidden rounded-3xl p-5 shadow-glass sm:p-6">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/70">
            Take a position
          </p>
          <h3 className="mt-0.5 font-display text-lg font-bold text-ink-200 sm:text-xl">
            {!tradable
              ? "Closed"
              : closingSoon
                ? "Closing soon"
                : awaitingFirstTrade
                  ? "Waiting for first prediction"
                  : "Open"}
          </h3>
        </div>
        <div className="text-right">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/70">
            Closes in
          </p>
          <p className="font-mono text-base font-semibold tabular-nums text-ink-200">
            {expired ? "—" : `${hh}:${mm}:${ss}`}
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2 rounded-2xl bg-ink-200/8 p-1.5">
        <SideButton active={side === "YES"} onClick={() => setSide("YES")} side="YES" cents={market.yesPriceCents} />
        <SideButton active={side === "NO"} onClick={() => setSide("NO")} side="NO" cents={market.noPriceCents} />
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between">
          <label htmlFor="amount" className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/70">
            Amount SOL
          </label>
          <button
            type="button"
            onClick={onMax}
            disabled={!balance.balance}
            className="rounded-md bg-ink-200/8 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-ink-200 transition hover:bg-ink-200/15 disabled:opacity-40"
          >
            MAX
          </button>
        </div>
        <div className="mt-1.5 flex items-center gap-2 rounded-2xl bg-cream-200 px-4 py-3 ring-1 ring-ink-200/10 focus-within:ring-ink-200/40">
          <input
            id="amount"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder="0"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            className="flex-1 bg-transparent font-display text-2xl font-bold tabular-nums text-ink-200 outline-none placeholder:text-ink-100/30"
            disabled={!tradable || isBusy(phase)}
          />
          <span className="font-mono text-xs text-ink-100/60">SOL</span>
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-ink-100/70">
          <span>
            Wallet:{" "}
            {wallet.connected && wallet.publicKey ? (
              <span className="font-mono text-ink-200">{shortenAddress(wallet.publicKey.toBase58())}</span>
            ) : (
              <span className="text-ink-100/50">not connected</span>
            )}
          </span>
          <span>
            Balance:{" "}
            <span className="font-mono tabular-nums text-ink-200">
              {balance.balance != null ? formatTrollBalance(balance.balance) : "—"}
            </span>
          </span>
        </div>
      </div>

      <div className="mt-5">
        <QuotePreview quote={phase.kind === "ready" ? phase.quote : null} side={side} />
      </div>

      {/* Phase status messages */}
      <PhaseBadge phase={phase} />

      {/* v54.2 (wording cleanup): the "No $TROLL detected" prompt was removed.
          It checked the TROLL SPL balance and prompted users to add TROLL,
          but the platform has been SOL-only since v47, so that prompt was
          actively misleading.  Insufficient-SOL is still caught at submit
          via the existing balance check below. */}

      {insufficient && phase.kind !== "error" && (
        <p className="mt-3 rounded-lg bg-no/15 px-3 py-2 text-xs text-no-deep ring-1 ring-no/30">
          You only have {formatTrollBalance(balance.balance!)} SOL — top up your wallet to enter this size.
        </p>
      )}

      <button
        type="button"
        onClick={onConfirm}
        disabled={
          !tradable ||
          phase.kind !== "ready" ||
          !wallet.connected ||
          insufficient ||
          noTroll
        }
        className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed ${
          side === "YES"
            ? "bg-yes text-ink-200 ring-1 ring-yes/40 hover:shadow-yes-glow"
            : "bg-no text-ink-200 ring-1 ring-no/40 hover:shadow-no-glow"
        }`}
      >
        {confirmLabel(phase, side, tradable, wallet.connected, noTroll)}
        {phase.kind === "ready" && tradable && wallet.connected && !noTroll && <span aria-hidden>→</span>}
      </button>

      <p className="mt-2.5 text-center text-[10px] leading-relaxed text-ink-100/60">
        Real SOL · 18+ · SOL transfers to escrow on confirm · Server verifies before your position is recorded
      </p>
    </div>
  );
}

function isBusy(phase: Phase): boolean {
  return ["signing", "broadcasting", "verifying", "ok"].includes(phase.kind);
}

function confirmLabel(
  phase: Phase,
  side: Side,
  tradable: boolean,
  connected: boolean,
  noTroll: boolean,
): string {
  // req 7: disconnected → "Connect wallet to predict"
  if (!connected) return "Connect wallet to predict";
  if (noTroll) return "No SOL detected";
  if (!tradable) return "Market closed";
  switch (phase.kind) {
    case "idle":
      return "Enter an amount";
    case "quoting":
      return "Quoting…";
    case "ready":
      return `Predict ${side}`;
    case "signing":
      return "Awaiting Phantom…";
    case "broadcasting":
      return "Broadcasting transfer…";
    case "verifying":
      return "Verifying on-chain…";
    case "ok":
      return "Position confirmed ✓";
    case "error":
      return `Predict ${side}`;
  }
}

function PhaseBadge({ phase }: { phase: Phase }) {
  if (phase.kind === "idle" || phase.kind === "ready" || phase.kind === "quoting") return null;
  if (phase.kind === "ok") {
    return (
      <p className="mt-3 rounded-lg bg-yes/15 px-3 py-2 text-xs text-yes-deep ring-1 ring-yes/40">
        ✓ Escrow deposit verified · position {phase.positionId.slice(0, 12)}… is live.
      </p>
    );
  }
  if (phase.kind === "error") {
    return (
      <p className="mt-3 rounded-lg bg-no/15 px-3 py-2 text-xs text-no-deep ring-1 ring-no/30">
        {phase.message}
      </p>
    );
  }
  // signing / broadcasting / verifying
  const labels: Record<string, string> = {
    signing: "Open Phantom and approve the transfer",
    broadcasting: "Sending the transaction to the cluster",
    verifying: "Server is verifying your deposit on-chain",
  };
  return (
    <p className="mt-3 flex items-center gap-2 rounded-lg bg-cyber-cyan/15 px-3 py-2 text-xs text-ink-200 ring-1 ring-cyber-cyan/30">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-cyber-cyan" />
      {labels[phase.kind]}
    </p>
  );
}

function SideButton({
  active,
  side,
  cents,
  onClick,
}: {
  active: boolean;
  side: "YES" | "NO";
  cents: number;
  onClick: () => void;
}) {
  const isYes = side === "YES";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-baseline justify-between rounded-xl px-3.5 py-2.5 text-left transition ${
        active
          ? isYes
            ? "bg-yes text-ink-200 shadow-yes-glow"
            : "bg-no text-ink-200 shadow-no-glow"
          : "bg-transparent text-ink-200/70 hover:bg-ink-200/5"
      }`}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
        {isYes ? "YES · Over" : "NO · Under"}
      </span>
      <span className="font-display text-base font-bold tabular-nums">{cents.toFixed(1)}¢</span>
    </button>
  );
}
