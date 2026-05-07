import { useEffect, useMemo, useState } from "react";
import { Route, Routes, Link, useNavigate } from "react-router-dom";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { WalletConnectButton } from "./components/WalletConnectButton";
import { MyPositions } from "./components/MyPositions";
import { Footer } from "./components/Footer";
import { Legal, type LegalPage } from "./components/Legal";
import { AdminPage } from "./pages/AdminPage";
import { MarketPage } from "./pages/MarketPage";
import { AuditPage } from "./pages/AuditPage";
import { TrollPage } from "./pages/TrollPage";
import { ClaimsPage } from "./pages/ClaimsPage";
import { useServerMarkets, useUserWithdrawals } from "./hooks/useServerMarkets";
import { useTrollBalance } from "./hooks/useTrollBalance";
import { useSolBalance } from "./hooks/useSolBalance";
import { useShortCountdown } from "./hooks/useShortCountdown";
import { api, type MarketSummary } from "./services/apiClient";
import { pickPanelMarkets } from "./services/marketSelection";
import { depositToEscrow, depositSolToEscrow, getTrollDecimals } from "./services/escrow";
import { formatTrollBalance } from "./services/trollBalance";
import type { Side, TradeQuote, ScheduleType } from "./market/marketTypes";

/* ------------------------------------------------------------------------- *
 * Live $TROLL ticker for the floating MC card.
 * Untouched from the prior version — same DexScreener pair source, same
 * 2-second cadence, same error handling.  Do NOT redesign this.
 * ------------------------------------------------------------------------- */

type TrollTicker = {
  priceUsd: number | null;
  marketCapUsd: number | null;
  updatedAt: Date | null;
  error: string | null;
};

const emptyTicker: TrollTicker = { priceUsd: null, marketCapUsd: null, updatedAt: null, error: null };

function getTrollPairAddress() {
  const configured = import.meta.env.VITE_DEXSCREENER_PAIR_URL || "https://dexscreener.com/solana/4w2cysotx6czaugmmwg13hdpy4qemg2czekyeqyk9ama";
  return configured.split("/").filter(Boolean).pop() || "4w2cysotx6czaugmmwg13hdpy4qemg2czekyeqyk9ama";
}

function getDexScreenerApiUrl() {
  return `https://api.dexscreener.com/latest/dex/pairs/solana/${getTrollPairAddress()}`;
}

function getDexScreenerEmbedUrl() {
  return `https://dexscreener.com/solana/${getTrollPairAddress()}?embed=1&theme=dark&trades=0&info=1`;
}

function useTrollTicker() {
  const [ticker, setTicker] = useState<TrollTicker>(emptyTicker);
  const apiUrl = useMemo(getDexScreenerApiUrl, []);

  useEffect(() => {
    let cancelled = false;

    async function loadTicker() {
      try {
        const response = await fetch(apiUrl, { cache: "no-store" });
        if (!response.ok) throw new Error(`DexScreener ${response.status}`);
        const data = await response.json();
        const pair = data?.pair;
        const priceUsd = Number(pair?.priceUsd);
        const marketCapUsd = Number(pair?.fdv ?? pair?.marketCap);

        if (!Number.isFinite(priceUsd) || !Number.isFinite(marketCapUsd)) {
          throw new Error("Missing live $TROLL price data");
        }

        if (!cancelled) {
          setTicker({ priceUsd, marketCapUsd, updatedAt: new Date(), error: null });
        }
      } catch (error) {
        if (!cancelled) {
          setTicker((current) => ({
            ...current,
            error: error instanceof Error ? error.message : "Price feed unavailable",
          }));
        }
      }
    }

    loadTicker();
    const timer = window.setInterval(loadTicker, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [apiUrl]);

  return ticker;
}

function formatUsdPrice(value: number | null) {
  if (value == null) return "$--";
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
}

function formatMarketCap(value: number | null) {
  if (value == null) return "$--";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(0)}`;
}

function useLiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function formatLiveClock(value: Date) {
  return value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatFeedStatus(value: Date | null, error: string | null) {
  if (error && !value) return "price feed loading";
  if (!value) return "fetching live feed";
  return "live DexScreener price";
}

/* ------------------------------------------------------------------------- *
 * Helpers for the predict panel
 * ------------------------------------------------------------------------- */

const SCHEDULE_LABEL: Record<ScheduleType, string> = {
  "15m": "15 Minute",
  hourly: "Hourly",
  daily: "Daily · 7PM ET",
};

/** Build the "1.8M $TROLL" / "7.4K $TROLL" / "421 $TROLL" volume label. */
function formatVolumeTroll(volume: number): string {
  if (!Number.isFinite(volume) || volume <= 0) return "0 $TROLL";
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(1)}M $TROLL`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}K $TROLL`;
  return `${Math.round(volume)} $TROLL`;
}

/** Whole-cent display, floored, kept in [1, 99] to match server clamping. */
function fmtCents(c: number | undefined | null): string {
  if (c == null || !Number.isFinite(c)) return "—";
  const clamped = Math.max(1, Math.min(99, c));
  return `${clamped.toFixed(0)}¢`;
}

/**
 * Always exactly three slots in the predict panel: one per schedule_type.
 *
 *   slots[0] = 15-minute   (active market, or null if none)
 *   slots[1] = hourly      (active market, or null if none)
 *   slots[2] = daily       (active market, or null if none)
 *
 * "Active" = status ∈ {open, locked}.  We do NOT show settled or voided
 * markets in the predict panel; once a market settles, the seeder creates
 * its replacement and the next /api/markets poll surfaces the new row.
 *
 * The brief "settling" window (between close and replacement) shows up as a
 * null slot, which the UI renders as "Creating new <type> market…".
 */
/**
 * Build the three predict-panel slots from the full /api/markets response.
 *
 * Selection rules live in `services/marketSelection.ts` (single source of
 * truth — also used by HomePage and TrollPage).  Priority order:
 *   open > locked > settling > settled > voided
 * Within a status bucket the LATEST closeAt wins.
 */
const PANEL_SLOTS: ScheduleType[] = ["15m", "hourly", "daily"];

function buildPanelSlots(all: MarketSummary[]): Array<{
  scheduleType: ScheduleType;
  market: MarketSummary | null;
  status: "active" | "settling" | "missing";
}> {
  return pickPanelMarkets(all).map(({ scheduleType, market }) => {
    if (market == null) {
      return { scheduleType, market: null, status: "missing" as const };
    }
    if (market.status === "settling") {
      return { scheduleType, market, status: "settling" as const };
    }
    return { scheduleType, market, status: "active" as const };
  });
}

/* ========================================================================= *
 * Routes
 * ========================================================================= */

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ClassicHome />} />
      <Route path="/troll" element={<TrollPage />} />
      <Route path="/market/:marketId" element={<MarketPage />} />
      <Route path="/audit/:marketId" element={<AuditPage />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="/claims" element={<ClaimsPage />} />
      <Route path="*" element={<ClassicHome />} />
    </Routes>
  );
}

/* ========================================================================= *
 * Brand — visual identity, do not redesign.
 * ========================================================================= */

function Brand() {
  return (
    <Link className="classic-brand" to="/" aria-label="pre-RICHARD-tion.fun home">
      <span className="brand-pre">pre-</span>
      <span className="brand-richard">
        RICHARD
        <span className="brand-strike" />
        <span className="brand-dic" aria-hidden="true">
          <span className="brand-dic-letter brand-dic-letter-d">D</span>
          <span className="brand-dic-letter brand-dic-letter-i">I</span>
          <span className="brand-dic-letter brand-dic-letter-c">C</span>
        </span>
      </span>
      <span className="brand-tail">-tion.fun</span>
    </Link>
  );
}

/* ========================================================================= *
 * ClassicHome — the landing page.  Visual layout is preserved exactly:
 *   - same nav, brand, wallet button
 *   - same hero copy card and CTA buttons
 *   - same MC float card (live $TROLL price, untouched)
 *   - same YES/NO/predict card layout, same class names
 *   - same Coin of the Day section with the DexScreener iframe
 *
 * What changed:
 *   - The hardcoded `markets` array is gone.
 *   - The predict card pulls real markets from /api/markets, and:
 *       · option buttons render real (id, schedule, lockAt, prices, volume)
 *       · YES/NO floating cards reflect the SELECTED real market's prices
 *       · the timer pill counts down to the SELECTED market's lockAt
 *       · the question heading shows the selected market's real target_mc
 *       · the YES/NO side toggle drives an auto-debounced /quote call
 *       · the amount input + MAX uses the real wallet $TROLL balance
 *       · the sign button runs the real escrow flow:
 *           1. POST /api/markets/:id/quote
 *           2. Phantom signs an SPL transferChecked
 *           3. broadcast + confirm
 *           4. POST /api/markets/:id/enter — server verifies on-chain, books
 *              the position only after the deposit is verified.
 *         No more "navigate(/admin)" stub.
 * ========================================================================= */

type Phase =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "ready"; quote: TradeQuote }
  | { kind: "signing" }
  | { kind: "broadcasting" }
  | { kind: "verifying" }
  | { kind: "ok"; positionId: string }
  | { kind: "error"; message: string };

function ClassicHome() {
  const navigate = useNavigate();
  const ticker = useTrollTicker();
  const liveClock = useLiveClock();
  const chartUrl = useMemo(getDexScreenerEmbedUrl, []);

  // Real backend markets.  Polled every 5 s by useServerMarkets.
  const { markets: allMarkets, escrowAccount, escrowSolAccount, error: marketsError } = useServerMarkets();
  // Always exactly 3 slots — one per schedule_type — possibly null/settling.
  const slots = useMemo(() => buildPanelSlots(allMarkets), [allMarkets]);
  // Convenience: tradable (status=active) market list, in slot order.
  const activeMarkets = useMemo(
    () => slots.filter((s) => s.status === "active" && s.market != null).map((s) => s.market!),
    [slots],
  );

  // Wallet, balance, and SPL connection.
  const wallet = useWallet();
  const { connection } = useConnection();
  const { setVisible: openWalletModal } = useWalletModal();
  const balance = useTrollBalance();
  // v23: parallel SOL balance + currency selector.  The currency state
  // controls which token the user is BETTING WITH.  Payouts always come
  // back in SOL regardless of which currency the user picked here.
  const solBalance = useSolBalance();
  const [currency, setCurrency] = useState<"troll" | "sol">("troll");
  const walletAddr = wallet.publicKey?.toBase58() ?? null;

  // Wallet pending withdrawals — drives the conditional "Payouts (N)" nav pill.
  // Polls every 8 s; quietly returns [] when wallet isn't connected.
  const { withdrawals: walletWithdrawals } = useUserWithdrawals(walletAddr);
  const pendingClaimCount = useMemo(
    () => walletWithdrawals.filter((w) => w.status === "pending" || w.status === "sent").length,
    [walletWithdrawals],
  );

  // ---------------- DEV LOGS for the user entry flow ---------------------
  // Mirrors the [entry]/[verify]/[settle]/[payout]/[claim] log conventions
  // on the server.  Use the browser console (or Vercel function logs) to
  // walk the chain end-to-end during testing.
  useEffect(() => {
    if (wallet.connecting) console.info("[entry/wallet] connecting…");
    if (wallet.disconnecting) console.info("[entry/wallet] disconnecting…");
  }, [wallet.connecting, wallet.disconnecting]);
  useEffect(() => {
    if (wallet.connected && walletAddr) {
      console.info(`[entry/wallet] CONNECTED wallet=${walletAddr}`);
    } else if (!wallet.connected) {
      console.info("[entry/wallet] disconnected");
    }
  }, [wallet.connected, walletAddr]);
  useEffect(() => {
    if (!walletAddr) return;
    if (balance.loading) console.info(`[entry/balance] loading wallet=${walletAddr}`);
    if (balance.error) console.warn(`[entry/balance] error wallet=${walletAddr} reason=${balance.error}`);
    if (balance.balance != null) {
      console.info(
        `[entry/balance] OK wallet=${walletAddr} balance=${balance.balance} $TROLL`,
      );
    }
  }, [walletAddr, balance.loading, balance.error, balance.balance]);

  // Predict-panel selection.  Defaults to the first active market;
  // automatically migrates if that market disappears or closes.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (activeMarkets.length === 0) {
      setSelectedId(null);
      return;
    }
    const isTradable = (m: typeof activeMarkets[number]): boolean =>
      m.status === "open" && new Date(m.closeAt) > new Date();
    const current = activeMarkets.find((m) => m.id === selectedId);
    // v40: auto-advance to a tradable market when selected is missing OR no
    // longer tradable (closed/locked).  Prefer same schedule first, then any
    // tradable market, and finally fall back to the first market in the list.
    if (!current || !isTradable(current)) {
      const sameSchedule = current
        ? activeMarkets.find((m) => m.scheduleType === current.scheduleType && isTradable(m))
        : null;
      const anyTradable = activeMarkets.find(isTradable);
      const next = sameSchedule ?? anyTradable ?? activeMarkets[0];
      if (next && next.id !== selectedId) setSelectedId(next.id);
    }
  }, [activeMarkets, selectedId]);
  const selected = activeMarkets.find((m) => m.id === selectedId) ?? null;

  const [side, setSide] = useState<Side>("YES");
  const [amountStr, setAmountStr] = useState("");
  const amount = useMemo(() => {
    const n = parseFloat(amountStr);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [amountStr]);

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  // v42: bumped after a successful entry, so MyPositions re-fetches
  // immediately to show the new position.
  const [positionsRefetchKey, setPositionsRefetchKey] = useState(0);
  const [legalPage, setLegalPage] = useState<LegalPage | null>(null);

  // v17: tradability is gated on closeAt, not lockAt — users can predict
  // any time before close, even in the final seconds.
  const tradable = !!selected && selected.status === "open" && new Date(selected.closeAt) > new Date();

  // Auto-quote whenever (selected, side, amount) settle.
  useEffect(() => {
    if (!selected || !tradable || amount <= 0) {
      setPhase({ kind: "idle" });
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setPhase({ kind: "quoting" });
      console.info(
        `[entry/quote] requesting market=${selected.id} side=${side} amount=${amount}`,
      );
      try {
        const { quote } = await api.quote(selected.id, side, amount);
        if (!cancelled) {
          console.info(
            `[entry/quote] response market=${selected.id} side=${side} ` +
              `shares=${quote.shares.toFixed(2)} avg=${quote.avgPriceCents.toFixed(1)}c ` +
              `priceBefore=${quote.marketPriceBeforeCents.toFixed(1)}c ` +
              `priceAfter=${quote.marketPriceAfterCents.toFixed(1)}c`,
          );
          setPhase({ kind: "ready", quote });
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Quote failed";
          console.warn(`[entry/quote] error market=${selected.id} reason=${msg}`);
          setPhase({ kind: "error", message: msg });
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [selected, side, amount, tradable]);

  // Countdown for the timer pill is bound to the selected market's closeAt.
  const headlineCountdown = useShortCountdown(selected ? new Date(selected.closeAt) : null);

  const onMax = () => {
    if (currency === "sol") {
      // Leave ~0.005 SOL for tx fees + any rent buffer.  SOL is reported
      // with 3 decimals on display, so we round down to 3 decimal places.
      const b = solBalance.balance ?? 0;
      const headroom = 0.005;
      const usable = Math.max(0, b - headroom);
      const v = Math.floor(usable * 1000) / 1000;
      if (v > 0) setAmountStr(v.toString());
    } else if (balance.balance != null && balance.balance > 0) {
      const v = Math.floor(balance.balance);
      setAmountStr(v.toString());
    }
  };

  const onSign = async () => {
    if (!selected) {
      setPhase({ kind: "error", message: "No market available right now." });
      return;
    }
    if (!wallet.connected || !wallet.publicKey) {
      openWalletModal(true);
      return;
    }
    if (!tradable) {
      setPhase({ kind: "error", message: "Market is closed." });
      return;
    }
    if (amount <= 0) {
      setPhase({ kind: "error", message: `Enter a${currency === "sol" ? " SOL" : " $TROLL"} amount.` });
      return;
    }

    // v23: balance + escrow checks dispatched by currency.
    if (currency === "sol") {
      if (!escrowSolAccount) {
        setPhase({ kind: "error", message: "Server hasn't reported a SOL escrow account yet." });
        return;
      }
      if (solBalance.balance != null && amount > solBalance.balance) {
        setPhase({ kind: "error", message: `You only have ${solBalance.balance.toFixed(3)} SOL.` });
        return;
      }
    } else {
      if (!escrowAccount) {
        setPhase({ kind: "error", message: "Server hasn't reported an escrow account yet." });
        return;
      }
      if (balance.balance != null && amount > balance.balance) {
        setPhase({ kind: "error", message: `You only have ${formatTrollBalance(balance.balance)} $TROLL.` });
        return;
      }
    }

    try {
      console.info(
        `[entry/sign] BEGIN market=${selected.id} side=${side} currency=${currency} amount=${amount} ` +
          `wallet=${wallet.publicKey.toBase58()}`,
      );

      // 1) Get a fresh quote (best price right before signing).
      setPhase({ kind: "quoting" });
      const { quote } = await api.quote(selected.id, side, amount, currency);
      console.info(
        `[entry/sign] quote-ok shares=${quote.shares.toFixed(2)} avg=${quote.avgPriceCents.toFixed(1)}c`,
      );
      void quote;

      // 2) Build + sign + broadcast — currency-specific tx.
      setPhase({ kind: "signing" });
      let signature: string;
      if (currency === "sol") {
        const escrowSolPk = new PublicKey(escrowSolAccount!);
        console.info(`[entry/sign] sol-build escrowSolAccount=${escrowSolAccount}`);
        setPhase({ kind: "broadcasting" });
        signature = await depositSolToEscrow({
          wallet,
          connection,
          escrowSolAccount: escrowSolPk,
          amountUiSol: amount,
        });
      } else {
        const mintStr = import.meta.env.VITE_TROLL_MINT?.trim();
        if (!mintStr) {
          setPhase({ kind: "error", message: "VITE_TROLL_MINT is not configured." });
          return;
        }
        const trollMint = new PublicKey(mintStr);
        const escrowAta = new PublicKey(escrowAccount!);
        const decimals = await getTrollDecimals(connection, trollMint);
        console.info(`[entry/sign] troll-build decimals=${decimals}`);
        setPhase({ kind: "broadcasting" });
        signature = await depositToEscrow({
          wallet,
          connection,
          trollMint,
          escrowTokenAccount: escrowAta,
          amountUi: amount,
          decimals,
        });
      }
      const shortSig = `${signature.slice(0, 8)}…${signature.slice(-6)}`;
      console.info(`[entry/sign] broadcast-ok sig=${shortSig}`);

      // 3) Server verifies on-chain THEN books the position.
      setPhase({ kind: "verifying" });
      const result = await api.enter(selected.id, {
        wallet: wallet.publicKey.toBase58(),
        side,
        amount,
        currency,
        signature,
      });
      console.info(
        `[entry/sign] DONE positionId=${result.positionId} tradeId=${result.tradeId} sig=${shortSig}`,
      );

      setPhase({ kind: "ok", positionId: result.positionId });
      setAmountStr("");
      setPositionsRefetchKey((k) => k + 1); // v42 trigger MyPositions refresh
      window.setTimeout(() => navigate(`/market/${selected.id}`), 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sign-in failed";
      console.warn(`[entry/sign] error market=${selected.id} reason=${msg}`);
      setPhase({ kind: "error", message: msg });
    }
  };

  // Sign-button label tracks phase.
  const signButtonLabel = (() => {
    if (!wallet.connected) return "Connect wallet to predict";
    if (!selected) return marketsError ? "Markets unavailable" : "Loading markets…";
    if (!tradable) return "Market closed";
    switch (phase.kind) {
      case "quoting":
        return "Quoting…";
      case "signing":
        return "Sign in Phantom…";
      case "broadcasting":
        return "Broadcasting…";
      case "verifying":
        return "Verifying on-chain…";
      case "ok":
        return "Confirmed ✓";
      case "error":
        return "Try again";
      default:
        return `Predict ${side}`;
    }
  })();

  const signDisabled =
    !selected ||
    !tradable ||
    phase.kind === "quoting" ||
    phase.kind === "signing" ||
    phase.kind === "broadcasting" ||
    phase.kind === "verifying" ||
    phase.kind === "ok" ||
    (wallet.connected && amount <= 0);

  // YES/NO floating-card prices reflect the selected real market.
  const yesCents = selected?.yesPriceCents;
  const noCents = selected?.noPriceCents;

  return (
    <main className="classic-page">
      <video className="classic-bg" src="/background.mp4" autoPlay muted loop playsInline />
      <div className="classic-wash" />
      <div className="classic-frame">
        <nav className="classic-nav">
          <Brand />
          <div className="classic-actions">
            {/* v21: only the Connect button + balance pills.  All scroll-
                target nav (Coin of the Day, Predict, Payouts) is removed
                — the whole flow fits on one desktop viewport without
                scrolling, so there's nothing to navigate to.  Pending
                payouts get a small badge inline elsewhere. */}
            <WalletConnectButton />
          </div>
        </nav>

        <section className="classic-hero">
          <div className="classic-copy-card">
            <p className="classic-eyebrow">$TROLL holder market</p>
            <h1>Prediction markets for $TROLL holders.</h1>
            <p className="classic-subcopy">
              Bet $TROLL or SOL on whether $TROLL market cap is higher or lower at the close. Pick a 15-minute, hourly, or daily window. Pick YES or NO. Win, get paid out instantly in SOL — no claims, no waiting. Markets are real, escrowed on-chain, and settled by oracle median.
            </p>
            {/* v24: no chart-link button — the embedded strip below
                renders the live DexScreener chart on-page. */}
          </div>

          {/* Live MC card — UNCHANGED from prior version. */}
          <div className={`classic-float-card mc-card ${ticker.error ? "is-stale" : "is-live"}`}>
            <small>Live $TROLL MC</small>
            <strong>{formatMarketCap(ticker.marketCapUsd)}</strong>
            <span>{formatUsdPrice(ticker.priceUsd)} · true pair price</span>
            <em>{formatFeedStatus(ticker.updatedAt, ticker.error)}</em>
            <i className="live-clock">CLOCK {formatLiveClock(liveClock)}</i>
          </div>

          {/* YES / NO float cards — same DOM, same classes, but values now
              come from the selected real market (or "—" before markets load). */}
          <div className="classic-float-card yes-float">
            <small>YES / OVER</small>
            <strong>{fmtCents(yesCents)}</strong>
            <span>{selected ? SCHEDULE_LABEL[selected.scheduleType] : "Live market"}</span>
          </div>
          <div className="classic-float-card no-float">
            <small>NO / UNDER</small>
            <strong>{fmtCents(noCents)}</strong>
            <span>moves against YES</span>
          </div>

          {/* Predict card — same classes, same layout.  Real backend data. */}
          <aside className="classic-predict-card" id="predict-panel">
            <div className="predict-head">
              <div>
                <p className="classic-eyebrow">Predict</p>
                <h2>{selected ? selected.question : "Loading market…"}</h2>
              </div>
              <div className="predict-head-right">
                {/* v22: discoverable /claims link.  Only renders when the
                    user has pending payouts — auto-payout normally drains
                    these within a few seconds of settle, but a row that
                    fails on-chain (RPC flake, missing ATA pre-creation)
                    sits as pending until it's retried.  This badge gives
                    users a way to see/claim such rows without us cluttering
                    the header on the no-pending case. */}
                {wallet.connected && pendingClaimCount > 0 && (
                  <button
                    type="button"
                    className="claims-pill"
                    onClick={() => navigate("/claims")}
                    title="View pending payouts"
                  >
                    <span aria-hidden className="claims-dot" />
                    {pendingClaimCount} payout{pendingClaimCount === 1 ? "" : "s"}
                  </button>
                )}
                <span className="timer-pill">{selected ? headlineCountdown : "—"}</span>
              </div>
            </div>

            <div className="market-options">
              {slots.map((slot) => {
                if (slot.status === "active" && slot.market) {
                  const m = slot.market;
                  return (
                    <MarketOptionButton
                      key={`${slot.scheduleType}:${m.id}`}
                      market={m}
                      active={m.id === selectedId}
                      onClick={() => {
                        setSelectedId(m.id);
                        setPhase({ kind: "idle" });
                      }}
                    />
                  );
                }
                // Either settling, or the rare race where active was set but the
                // market disappeared between buildPanelSlots and render — in either
                // case render the placeholder.
                const placeholderState: "settling" | "missing" =
                  slot.status === "settling" ? "settling" : "missing";
                return (
                  <PlaceholderSlot
                    key={`${slot.scheduleType}:placeholder`}
                    scheduleType={slot.scheduleType}
                    state={placeholderState}
                    error={marketsError}
                  />
                );
              })}
            </div>

            <div className="side-row">
              <button
                className="yes-side"
                type="button"
                onClick={() => setSide("YES")}
                style={side === "YES" ? undefined : { opacity: 0.55 }}
                aria-pressed={side === "YES"}
              >
                YES {fmtCents(yesCents)}
              </button>
              <button
                className="no-side"
                type="button"
                onClick={() => setSide("NO")}
                style={side === "NO" ? undefined : { opacity: 0.55 }}
                aria-pressed={side === "NO"}
              >
                NO {fmtCents(noCents)}
              </button>
            </div>

            {/* v23 currency toggle — TROLL or SOL.  Same odds either way;
                payouts always come back in SOL regardless of pick. */}
            <div className="currency-toggle" role="tablist" aria-label="Bet currency">
              <button
                type="button"
                role="tab"
                aria-selected={currency === "troll"}
                className={currency === "troll" ? "active" : ""}
                onClick={() => { setCurrency("troll"); setAmountStr(""); setPhase({ kind: "idle" }); }}
              >
                $TROLL
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={currency === "sol"}
                className={currency === "sol" ? "active" : ""}
                onClick={() => { setCurrency("sol"); setAmountStr(""); setPhase({ kind: "idle" }); }}
              >
                SOL
              </button>
            </div>

            <label className="amount-label" htmlFor="amount">
              How much {currency === "sol" ? "SOL" : "$TROLL"} do you want to put up?
            </label>
            <div className="amount-row">
              <input
                id="amount"
                inputMode="decimal"
                placeholder="0"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
              />
              <button
                type="button"
                onClick={onMax}
                disabled={currency === "sol" ? !solBalance.balance : !balance.balance}
              >
                MAX
              </button>
            </div>

            <div className="quote-box">
              <span>
                Price <b>{fmtCents(side === "YES" ? yesCents : noCents)}</b>
              </span>
              <span>
                Estimated contracts{" "}
                <b>
                  {phase.kind === "ready"
                    ? phase.quote.shares.toLocaleString(undefined, { maximumFractionDigits: 0 })
                    : "--"}
                </b>
              </span>
              <span>
                Wallet balance{" "}
                <b>
                  {currency === "sol"
                    ? (solBalance.balance != null ? `${solBalance.balance.toFixed(3)} SOL` : "--")
                    : (balance.balance != null ? `${formatTrollBalance(balance.balance)} $TROLL` : "--")}
                </b>
              </span>
              {phase.kind === "error" && (
                <span style={{ color: "#9c1232" }}>
                  Error <b>{phase.message}</b>
                </span>
              )}
              {phase.kind === "ok" && (
                <span style={{ color: "#006c3b" }}>
                  Status <b>position recorded · routing…</b>
                </span>
              )}
            </div>

            <button className="sign-button" type="button" onClick={onSign} disabled={signDisabled}>
              {signButtonLabel}
            </button>
          </aside>
        </section>

        {/* v42: connected user's open positions with live P/L. */}
        <MyPositions
          walletAddress={wallet.publicKey?.toBase58() ?? null}
          markets={allMarkets}
          refetchKey={positionsRefetchKey}
        />

        {/* v24: thin DexScreener strip docked to the bottom of the viewport.
            v21 removed the full chart section to enforce one-page; v24
            brings back a compact 200px-tall strip that fits in the
            remaining viewport space below the hero.  Zero scroll on
            desktop — the hero shrinks just enough to leave room. */}
        <section className="chart-strip" aria-label="$TROLL live chart">
          <iframe
            title="$TROLL live chart"
            src={chartUrl}
            allow="clipboard-write"
            loading="lazy"
          />
        </section>
      </div>

      {/* v42: footer with social + legal links + legal modal */}
      <Footer onShowLegal={(p) => setLegalPage(p)} />
      <Legal page={legalPage} onClose={() => setLegalPage(null)} onSwitch={(p) => setLegalPage(p)} />
    </main>
  );
}

/* ------------------------------------------------------------------------- *
 * Single market option button.  Pure presentational, but wired so the
 * countdown ticks per-second per market.
 *
 * Same .market-option class structure as the prior static version:
 *
 *   <button class="market-option [active]">
 *     <span><b>{label}</b><em>{time}</em></span>
 *     <small>{question}</small>
 *     <span class="price-row"><b class="yes">YES Xc</b><b class="no">NO Yc</b></span>
 *     <small>Volume {fmt}</small>
 *   </button>
 * ------------------------------------------------------------------------- */
function MarketOptionButton({
  market,
  active,
  onClick,
}: {
  market: MarketSummary;
  active: boolean;
  onClick: () => void;
}) {
  // v17: countdown ticks to closeAt (not lockAt).  The "Closing soon" chip
  // appears in the final 60s — no entry blocking, just a visual cue that
  // price action is most volatile right now.
  const closeAtDate = useMemo(() => new Date(market.closeAt), [market.closeAt]);
  const time = useShortCountdown(closeAtDate);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const msUntilClose = closeAtDate.getTime() - nowMs;
  const closingSoon = market.status === "open" && msUntilClose > 0 && msUntilClose < 60_000;

  return (
    <button
      type="button"
      className={`market-option ${active ? "active" : ""} ${closingSoon ? "closing-soon" : ""}`}
      onClick={onClick}
    >
      <span>
        <b>{SCHEDULE_LABEL[market.scheduleType]}</b>
        <em>{closingSoon ? `Closing soon · ${time}` : time}</em>
      </span>
      <small>{market.question}</small>
      <span className="price-row">
        <b className="yes">YES {fmtCents(market.yesPriceCents)}</b>
        <b className="no">NO {fmtCents(market.noPriceCents)}</b>
      </span>
      <small>Volume {formatVolumeTroll(market.volume)}</small>
    </button>
  );
}

/* ------------------------------------------------------------------------- *
 * Placeholder slot.  Renders in the predict panel when one of the three
 * schedules has no active market — most commonly during the brief window
 * between a market settling and the seeder creating its replacement.
 *
 * Same .market-option DOM/classes as the real buttons so the surrounding
 * 3-column grid layout is preserved.  Disabled and not-clickable.
 * ------------------------------------------------------------------------- */
function PlaceholderSlot({
  scheduleType,
  state,
  error,
}: {
  scheduleType: ScheduleType;
  state: "settling" | "missing";
  error: string | null;
}) {
  const label = SCHEDULE_LABEL[scheduleType];
  const headline =
    state === "settling" ? "Settling…" : error ? "No active market" : "Creating market…";
  const detail =
    state === "settling"
      ? "Window closed. Next market opens shortly."
      : error
        ? `Server error: ${error}`
        : `No active ${label.toLowerCase()} market right now. The seeder runs every cycle.`;
  return (
    <button
      type="button"
      className="market-option"
      disabled
      style={{ cursor: "default", opacity: 0.65 }}
    >
      <span>
        <b>{label}</b>
        <em>{headline}</em>
      </span>
      <small>{detail}</small>
      <span className="price-row">
        <b className="yes">YES —</b>
        <b className="no">NO —</b>
      </span>
      <small>Volume —</small>
    </button>
  );
}
