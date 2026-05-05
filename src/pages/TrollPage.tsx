import { MarketCard } from "../components/MarketCard";
import { useTrollMarketData } from "../hooks/useTrollMarketData";
import { useServerMarkets } from "../hooks/useServerMarkets";
import { formatMC, formatPrice } from "../services/marketData";
import { TrollChart } from "../components/TrollChart";
import { pickActivePanelMarkets } from "../services/marketSelection";

export function TrollPage() {
  const { markets, loading, error } = useServerMarkets();
  const { data, loading: mdLoading } = useTrollMarketData();

  const open = pickActivePanelMarkets(markets);
  const recent = markets.filter((m) => m.status === "settled" || m.status === "voided").slice(0, 6);

  return (
    <main className="relative min-h-screen px-4 pb-24 pt-28 sm:px-8 sm:pt-32">
      <div className="mx-auto max-w-[1280px]">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-yes">
              <span aria-hidden className="mr-1.5">▲</span>
              Predict $TROLL
            </p>
            <h1 className="mt-2 font-display text-4xl font-bold tracking-tightest text-cream-100 sm:text-5xl">
              Pick over or under.
            </h1>
            <p className="mt-2 max-w-xl text-cream-100/70">
              Three schedules, one question:{" "}
              <span className="text-cream-100">
                will $TROLL be above the target market cap when the window closes?
              </span>
            </p>
          </div>

          {/* Live MC strip */}
          <div className="glass-dark rounded-2xl p-4 ring-1 ring-cream-100/10 sm:min-w-[300px]">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-cream-100/60">
              $TROLL · live
            </p>
            <div className="mt-2 grid grid-cols-3 gap-3">
              <div>
                <p className="text-[10px] text-cream-100/50">MC</p>
                <p className="font-display text-base font-bold tabular-nums text-cream-100">
                  {mdLoading ? "—" : formatMC(data?.marketCapUsd)}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-cream-100/50">Price</p>
                <p className="font-display text-base font-bold tabular-nums text-cream-100">
                  {mdLoading ? "—" : formatPrice(data?.priceUsd)}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-cream-100/50">Vol 24h</p>
                <p className="font-display text-base font-bold tabular-nums text-cream-100">
                  {mdLoading ? "—" : formatMC(data?.volume24hUsd)}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Chart */}
        <div className="mt-8">
          <TrollChart height={360} />
        </div>

        {/* Open markets */}
        <div className="mt-12">
          <div className="flex items-end justify-between">
            <h2 className="font-display text-2xl font-bold tracking-tightest text-cream-100 sm:text-3xl">
              Open windows
            </h2>
            <p className="text-xs text-cream-100/60">{open.length} markets</p>
          </div>

          {error && (
            <p className="mt-3 rounded-2xl bg-no/15 px-4 py-3 text-sm text-no-deep ring-1 ring-no/30">
              ⚠ {error}
            </p>
          )}
          {loading && open.length === 0 && (
            <p className="mt-3 text-sm text-cream-100/55">Loading markets from server…</p>
          )}
          {!loading && open.length === 0 && !error && (
            <p className="mt-3 text-sm text-cream-100/55">
              No open markets right now. Admin can create one at <code className="font-mono">/admin</code>.
            </p>
          )}

          <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            {open.map((m) => (
              <MarketCard key={m.id} market={m} />
            ))}
          </div>
        </div>

        {/* Recently settled */}
        {recent.length > 0 && (
          <div className="mt-16">
            <h2 className="font-display text-xl font-bold tracking-tightest text-cream-100/80">
              Recently settled
            </h2>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {recent.map((m) => (
                <MarketCard key={m.id} market={m} />
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
