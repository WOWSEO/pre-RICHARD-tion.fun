import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTrollMarketData } from "../hooks/useTrollMarketData";
import { formatMC, formatPrice } from "../services/marketData";
import { TrollChart } from "./TrollChart";

/**
 * "Coin of the Day" — a focused panel about $TROLL right now: logo placeholder,
 * MC, price, 24h volume, embedded chart, and a CTA into the prediction flow.
 *
 * Implemented as a centered modal over a backdrop. ESC + click-outside close it.
 */
export function CoinOfDayModal({ onClose }: { onClose: () => void }) {
  const { data, loading } = useTrollMarketData();
  const navigate = useNavigate();

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Coin of the Day — $TROLL"
      className="fixed inset-0 z-50 grid place-items-center px-4 py-6"
    >
      {/* backdrop */}
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink-200/70 backdrop-blur-md"
      />

      {/* dialog */}
      <div className="relative z-10 w-full max-w-3xl animate-fade-up">
        <div className="glass scanlines relative overflow-hidden rounded-3xl p-6 shadow-glass-lift sm:p-8">
          {/* header */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div
                className="grid h-14 w-14 place-items-center rounded-2xl text-2xl font-display font-bold"
                style={{
                  background: "linear-gradient(135deg, #74FF3D 0%, #B23BFF 100%)",
                  color: "#0E0F12",
                  boxShadow: "0 0 32px -4px rgba(116,255,61,0.5)",
                }}
                aria-hidden
              >
                T
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/70">
                  Coin of the Day
                </p>
                <h2 className="font-display text-2xl font-bold tracking-tightest text-ink-200 sm:text-3xl">
                  $TROLL
                </h2>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close dialog"
              className="grid h-9 w-9 place-items-center rounded-full bg-ink-200/10 text-ink-100 transition hover:bg-ink-200/20"
            >
              ✕
            </button>
          </div>

          {/* stats strip */}
          <div className="mt-5 grid grid-cols-3 gap-3 sm:gap-5">
            <Stat label="Market cap" value={formatMC(data?.marketCapUsd)} loading={loading} accent="green" />
            <Stat label="Price" value={formatPrice(data?.priceUsd)} loading={loading} />
            <Stat label="Volume 24h" value={formatMC(data?.volume24hUsd)} loading={loading} />
          </div>

          {/* chart */}
          <div className="mt-5">
            <TrollChart height={360} />
          </div>

          {/* footer CTAs */}
          <div className="mt-5 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-ink-100/70">
              Source:{" "}
              <span className="font-mono text-ink-200">
                {data?.source && data.source !== "none" ? data.source : "—"}
              </span>{" "}
              · FDV displayed as MC.
            </p>
            <button
              onClick={() => {
                onClose();
                navigate("/troll");
              }}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-ink-200 px-5 py-2.5 text-sm font-semibold text-yes ring-1 ring-yes/40 transition hover:shadow-yes-glow"
            >
              Predict $TROLL
              <span aria-hidden>→</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  loading,
  accent,
}: {
  label: string;
  value: string;
  loading: boolean;
  accent?: "green";
}) {
  return (
    <div className="rounded-2xl bg-ink-200/5 p-3 ring-1 ring-ink-200/10">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/60">{label}</p>
      <p
        className={`mt-1 font-display text-lg font-bold tabular-nums sm:text-xl ${
          accent === "green" ? "text-yes-deep" : "text-ink-200"
        }`}
      >
        {loading ? <span className="text-ink-100/40">—</span> : value}
      </p>
    </div>
  );
}
