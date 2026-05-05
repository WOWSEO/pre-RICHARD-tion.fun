import { Link } from "react-router-dom";
import { useState } from "react";
import { FloatingHeroCards } from "../components/FloatingHeroCards";
import { CoinOfDayModal } from "../components/CoinOfDayModal";
import { MarketCard } from "../components/MarketCard";
import { useServerMarkets } from "../hooks/useServerMarkets";
import { pickActivePanelMarkets } from "../services/marketSelection";

export function HomePage() {
  const { markets, loading, error } = useServerMarkets();
  const [showCotd, setShowCotd] = useState(false);

  // Show only ACTIVE picks up top — one per schedule, priority + latest
  // closeAt.  Old voided rows that sit alongside fresh open ones can't
  // appear here; pickActivePanelMarkets filters to {open, locked} only.
  const openMarkets = pickActivePanelMarkets(markets);

  // Floating YES/NO chips read from the freshest active market.
  const lead = openMarkets[0] ?? markets[0];
  const yesCents = lead?.yesPriceCents ?? 50;
  const noCents = lead?.noPriceCents ?? 50;
  const totalUsers = new Set(
    markets.flatMap(() => []) // we don't have a user list endpoint yet — keep simple
  ).size;

  return (
    <main className="relative min-h-screen pb-24 pt-28 sm:pt-32">
      {/* Hero */}
      <section className="relative px-4 sm:px-8">
        <div className="mx-auto max-w-[1280px]">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-8">
            <div className="relative z-10 lg:col-span-6 xl:col-span-5">
              <p className="animate-fade-up font-mono text-[11px] uppercase tracking-[0.22em] text-yes">
                <span aria-hidden className="mr-1.5">▲</span>
                YES/NO market for $TROLL holders
              </p>
              <h1
                className="animate-fade-up mt-3 font-display text-5xl font-bold leading-[0.95] tracking-tightest text-cream-100 text-balance sm:text-6xl xl:text-7xl"
                style={{ animationDelay: "0.05s" }}
              >
                Prediction markets{" "}
                <span className="bg-gradient-to-r from-yes via-cyber-cyan to-cyber-magenta bg-clip-text text-transparent">
                  for $TROLL
                </span>{" "}
                holders.
              </h1>
              <p
                className="animate-fade-up mt-5 max-w-lg text-base leading-relaxed text-cream-100/75 sm:text-lg"
                style={{ animationDelay: "0.1s" }}
              >
                Connect Phantom, deposit real $TROLL into market escrow, and pick{" "}
                <span className="font-mono font-semibold text-yes">YES</span> or{" "}
                <span className="font-mono font-semibold text-no">NO</span> on $TROLL market-cap targets.
                15-minute, hourly, and daily 7PM ET windows — settled by median of two oracles.
              </p>

              <div
                className="animate-fade-up mt-8 flex flex-wrap items-center gap-3"
                style={{ animationDelay: "0.15s" }}
              >
                <Link
                  to="/troll"
                  className="inline-flex items-center gap-2 rounded-full bg-yes px-6 py-3.5 text-sm font-semibold text-ink-200 ring-1 ring-yes/40 transition hover:shadow-yes-glow"
                >
                  Predict $TROLL
                  <span aria-hidden>→</span>
                </Link>
                <button
                  onClick={() => setShowCotd(true)}
                  className="inline-flex items-center gap-2 rounded-full bg-cream-100/8 px-6 py-3.5 text-sm font-semibold text-cream-100 ring-1 ring-cream-100/15 backdrop-blur-md transition hover:bg-cream-100/15"
                >
                  View Coin of the Day
                </button>
              </div>

              <p
                className="animate-fade-up mt-8 font-mono text-[10px] uppercase tracking-wider text-cream-100/50"
                style={{ animationDelay: "0.2s" }}
              >
                Real $TROLL escrow · 18+ · Holder-vs-holder settlement
              </p>
            </div>

            <div className="relative lg:col-span-6 xl:col-span-7">
              <FloatingHeroCards yesCents={yesCents} noCents={noCents} totalUsers={totalUsers} />
            </div>
          </div>
        </div>
      </section>

      {/* Active markets preview */}
      <section className="relative mt-16 px-4 sm:mt-24 sm:px-8">
        <div className="mx-auto max-w-[1280px]">
          <div className="flex items-end justify-between">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-cream-100/60">
                Live markets
              </p>
              <h2 className="mt-1 font-display text-2xl font-bold tracking-tightest text-cream-100 sm:text-3xl">
                {openMarkets.length > 0 ? `${openMarkets.length} windows open right now` : "No live markets"}
              </h2>
            </div>
            <Link
              to="/troll"
              className="hidden text-xs text-cream-100/70 underline-offset-4 hover:text-yes hover:underline sm:inline"
            >
              View all →
            </Link>
          </div>

          {loading && openMarkets.length === 0 && (
            <p className="mt-6 text-sm text-cream-100/55">Loading markets…</p>
          )}
          {error && (
            <p className="mt-6 rounded-2xl bg-no/15 px-4 py-3 text-sm text-no-deep ring-1 ring-no/30">
              ⚠ {error}. Is the server running? Set <code className="font-mono">VITE_API_BASE_URL</code> in your .env.
            </p>
          )}

          {openMarkets.length > 0 && (
            <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
              {openMarkets.map((m) => (
                <MarketCard key={m.id} market={m} />
              ))}
            </div>
          )}
        </div>
      </section>

      {showCotd && <CoinOfDayModal onClose={() => setShowCotd(false)} />}
    </main>
  );
}
