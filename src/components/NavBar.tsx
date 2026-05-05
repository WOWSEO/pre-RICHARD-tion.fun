import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import { WalletConnectButton } from "./WalletConnectButton";
import { CoinOfDayModal } from "./CoinOfDayModal";

export function NavBar() {
  const [showCotd, setShowCotd] = useState(false);
  const navigate = useNavigate();

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-40 px-4 sm:px-8 pt-5">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between">
          {/* Left: wordmark */}
          <Link
            to="/"
            className="group flex items-center gap-2.5 select-none"
            aria-label="prerichardtion.fun home"
          >
            <span
              className="grid h-8 w-8 place-items-center rounded-md font-mono text-sm font-bold text-ink-200"
              style={{
                background: "linear-gradient(135deg, #74FF3D 0%, #3DFFFC 100%)",
                boxShadow: "0 0 24px -2px rgba(116, 255, 61, 0.6)",
              }}
            >
              p
            </span>
            <span className="font-display text-[15px] sm:text-[17px] font-semibold tracking-tightest text-cream-100">
              prerichardtion<span className="text-yes">.</span>fun
            </span>
          </Link>

          {/* Right: nav links + CTA + wallet */}
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              onClick={() => setShowCotd(true)}
              className="hidden md:inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium text-cream-100/85 transition-colors hover:text-cream-100 hover:bg-cream-100/5"
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-yes animate-pulse"
                style={{ boxShadow: "0 0 8px rgba(116, 255, 61, 0.9)" }}
              />
              Coin of the Day
            </button>
            <button
              onClick={() => navigate("/troll")}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium text-cream-100/85 transition-colors hover:text-cream-100 hover:bg-cream-100/5"
            >
              Predict
              <span aria-hidden className="text-yes">↗</span>
            </button>
            <WalletConnectButton />
          </div>
        </div>
      </nav>

      {showCotd && <CoinOfDayModal onClose={() => setShowCotd(false)} />}
    </>
  );
}
