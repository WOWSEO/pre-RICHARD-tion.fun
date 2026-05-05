import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AdminOverview } from "../services/apiClient";
import { formatTrollBalance, shortenAddress } from "../services/trollBalance";
import type { ScheduleType } from "../market/marketTypes";

const ADMIN_KEY_STORAGE = "prerichardtion.admin.key";

export function AdminPage() {
  const [adminKey, setAdminKey] = useState<string>(
    () => sessionStorage.getItem(ADMIN_KEY_STORAGE) ?? "",
  );
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!adminKey) {
      setOverview(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      try {
        const data = await api.adminOverview(adminKey);
        if (!cancelled) {
          setOverview(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) timer = setTimeout(run, 10_000);
      }
    };
    run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [adminKey]);

  const saveKey = (k: string) => {
    setAdminKey(k);
    if (k) sessionStorage.setItem(ADMIN_KEY_STORAGE, k);
    else sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  };

  const fireToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      fireToast(`⚠ ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const onCreateMarket = (scheduleType: ScheduleType) =>
    wrap(async () => {
      const result = await api.createMarket(adminKey, { scheduleType });
      if (result.created) {
        const mc = result.openMc != null ? `$${(result.openMc / 1_000_000).toFixed(2)}M` : "—";
        fireToast(`✓ Created ${scheduleType} market ${result.marketId ?? ""} · open MC ${mc}`);
      } else {
        fireToast(`· ${scheduleType}: ${result.reason ?? "no-op"}`);
      }
    });

  const onSeedAll = () =>
    wrap(async () => {
      const r = await api.seedMarkets(adminKey);
      const created = r.results.filter((x) => x.created).length;
      const noop = r.results.length - created;
      fireToast(`✓ Seed complete · ${created} created, ${noop} already active`);
    });

  const onVoid = (marketId: string, reason: string) =>
    wrap(async () => {
      await api.voidMarket(adminKey, marketId, reason);
      fireToast(`✓ Voided ${marketId}`);
    });

  const onSettle = (marketId: string) =>
    wrap(async () => {
      const r = await api.triggerSettle(adminKey, marketId);
      fireToast(`✓ Settled ${marketId} — ${r.outcome} (${r.userSettlements} settlements, ${r.withdrawalsQueued} withdrawals queued)`);
    });

  const onPayouts = () =>
    wrap(async () => {
      const r = await api.runPayouts(adminKey, 50);
      fireToast(`✓ Processed ${r.processed} withdrawals`);
    });

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  if (!adminKey) {
    return (
      <main className="relative min-h-screen px-4 pt-32 sm:px-8">
        <div className="mx-auto max-w-md glass rounded-3xl p-8 shadow-glass">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-100/60">Admin</p>
          <h1 className="mt-2 font-display text-2xl font-bold text-ink-200">Enter admin key</h1>
          <p className="mt-2 text-sm text-ink-100/70">
            Stored in sessionStorage only. Server matches against the{" "}
            <code className="font-mono">ADMIN_API_KEY</code> env var.
          </p>
          <KeyForm onSubmit={saveKey} />
          <Link to="/" className="mt-4 inline-block text-xs text-ink-100/60 hover:text-yes">
            ← Home
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen px-4 pb-32 pt-28 sm:px-8 sm:pt-32">
      <div className="mx-auto max-w-[1280px]">
        {/* header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-yes">▲ Admin</p>
            <h1 className="mt-1 font-display text-3xl font-bold tracking-tightest text-cream-100 sm:text-4xl">
              Operations console
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onSeedAll}
              disabled={busy}
              className="rounded-full bg-cyber-cyan/30 px-4 py-2 text-xs font-semibold text-ink-200 ring-1 ring-cyber-cyan/40 transition hover:bg-cyber-cyan/40 disabled:opacity-50"
            >
              {busy ? "Working…" : "Seed markets"}
            </button>
            <button
              onClick={onPayouts}
              disabled={busy}
              className="rounded-full bg-yes px-4 py-2 text-xs font-semibold text-ink-200 ring-1 ring-yes/40 transition hover:shadow-yes-glow disabled:opacity-50"
            >
              {busy ? "Working…" : "Run pending payouts"}
            </button>
            <button
              onClick={() => saveKey("")}
              className="rounded-full bg-cream-100/8 px-3 py-2 text-xs text-cream-100 ring-1 ring-cream-100/15 hover:bg-cream-100/15"
            >
              Sign out
            </button>
          </div>
        </div>

        {error && (
          <p className="mt-5 rounded-2xl bg-no/15 px-4 py-3 text-sm text-no-deep ring-1 ring-no/30">
            ⚠ {error}
          </p>
        )}

        {/* escrow totals */}
        {overview && (
          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
            <Stat
              label="Escrow account"
              value={shortenAddress(overview.escrowAccount)}
              sub={overview.escrowAccount}
              link={`https://solscan.io/account/${overview.escrowAccount}`}
            />
            <Stat
              label="Confirmed deposits"
              value={`${formatTrollBalance(overview.escrowConfirmedTotal)} $TROLL`}
            />
            <Stat
              label="Pending withdrawals"
              value={`${formatTrollBalance(overview.pendingWithdrawalTotal)} $TROLL`}
            />
          </div>
        )}

        {/* create market */}
        <section className="mt-10">
          <h2 className="font-display text-xl font-bold tracking-tightest text-cream-100">
            Create one market (per schedule)
          </h2>
          <p className="mt-1 text-xs text-cream-100/55">
            Picks the next 15-min/hourly/7PM-ET boundary, snapshots live $TROLL MC at insert time,
            and sets that as the higher/lower threshold. Skipped (with reason) if a market for that
            schedule is already active. To fill all 3 slots at once, use{" "}
            <span className="font-mono">Seed markets</span> at the top of the page.
          </p>
          <CreateMarketForm onSubmit={onCreateMarket} disabled={busy} />
        </section>

        {/* markets */}
        {overview && (
          <section className="mt-10">
            <h2 className="font-display text-xl font-bold tracking-tightest text-cream-100">
              Markets ({overview.markets.length})
            </h2>
            <div className="mt-3 overflow-hidden rounded-2xl ring-1 ring-cream-100/10">
              <table className="w-full text-xs">
                <thead className="bg-ink-200/40 text-cream-100/70">
                  <tr>
                    <Th>ID</Th>
                    <Th>Schedule</Th>
                    <Th>Target MC</Th>
                    <Th>Close</Th>
                    <Th>Status</Th>
                    <Th>YES / NO</Th>
                    <Th>Vol · OI</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {overview.markets.map((m) => (
                    <tr key={m.id} className="border-t border-cream-100/10 bg-ink-200/20">
                      <Td><span className="font-mono">{m.id}</span></Td>
                      <Td>{m.schedule_type}</Td>
                      <Td>${(Number.parseFloat(m.target_mc) / 1_000_000).toFixed(1)}M</Td>
                      <Td>{new Date(m.close_at).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}</Td>
                      <Td>
                        <span className="rounded-full bg-cream-100/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider">
                          {m.status}
                        </span>
                      </Td>
                      <Td>
                        <span className="font-mono">
                          {Number.parseFloat(m.yes_price_cents).toFixed(0)}¢ ·{" "}
                          {Number.parseFloat(m.no_price_cents).toFixed(0)}¢
                        </span>
                      </Td>
                      <Td>
                        <span className="font-mono">
                          {Number.parseFloat(m.volume).toFixed(0)} · {Number.parseFloat(m.open_interest).toFixed(0)}
                        </span>
                      </Td>
                      <Td align="right">
                        <div className="flex justify-end gap-1.5">
                          <Link
                            to={`/market/${m.id}`}
                            className="rounded-md bg-cream-100/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider hover:bg-cream-100/20"
                          >
                            view
                          </Link>
                          {m.status !== "settled" && m.status !== "voided" && (
                            <>
                              <button
                                disabled={busy}
                                onClick={() => onSettle(m.id)}
                                className="rounded-md bg-cyber-cyan/20 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-cyber-cyan hover:bg-cyber-cyan/30 disabled:opacity-50"
                              >
                                settle
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => {
                                  const r = window.prompt(`Void ${m.id}? Enter reason:`, "admin_void");
                                  if (r) onVoid(m.id, r);
                                }}
                                className="rounded-md bg-no/20 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-no-deep hover:bg-no/30 disabled:opacity-50"
                              >
                                void
                              </button>
                            </>
                          )}
                        </div>
                      </Td>
                    </tr>
                  ))}
                  {overview.markets.length === 0 && (
                    <tr>
                      <Td colSpan={8} align="center">
                        <span className="text-cream-100/50 italic">No markets yet — create one above.</span>
                      </Td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* recent deposits + withdrawals */}
        {overview && (
          <div className="mt-10 grid gap-6 lg:grid-cols-2">
            <section>
              <h2 className="font-display text-lg font-bold tracking-tightest text-cream-100">
                Recent deposits
              </h2>
              <div className="mt-2 space-y-1.5 text-xs">
                {overview.recentDeposits.length === 0 && (
                  <p className="text-cream-100/55 italic">No deposits yet.</p>
                )}
                {overview.recentDeposits.map((d) => (
                  <div
                    key={d.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl glass-dark p-2.5 ring-1 ring-cream-100/10"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-cream-100">
                        {shortenAddress(d.wallet)} → {Number.parseFloat(d.amount_troll).toFixed(2)} $TROLL · {d.side}
                      </p>
                      <p className="truncate font-mono text-[10px] text-cream-100/50">
                        sig {shortenAddress(d.signature)} · {d.market_id}
                      </p>
                      {d.failure_reason && (
                        <p className="mt-0.5 text-[10px] text-no-deep">⚠ {d.failure_reason}</p>
                      )}
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                        d.status === "confirmed"
                          ? "bg-yes/20 text-yes-deep"
                          : d.status === "failed"
                            ? "bg-no/20 text-no-deep"
                            : "bg-cyber-cyan/20 text-cyber-cyan"
                      }`}
                    >
                      {d.status}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h2 className="font-display text-lg font-bold tracking-tightest text-cream-100">
                Recent withdrawals
              </h2>
              <div className="mt-2 space-y-1.5 text-xs">
                {overview.recentWithdrawals.length === 0 && (
                  <p className="text-cream-100/55 italic">No withdrawals yet.</p>
                )}
                {overview.recentWithdrawals.map((w) => (
                  <div
                    key={w.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl glass-dark p-2.5 ring-1 ring-cream-100/10"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-cream-100">
                        {Number.parseFloat(w.amount_troll).toFixed(2)} $TROLL → {shortenAddress(w.wallet)} · {w.reason}
                      </p>
                      <p className="truncate font-mono text-[10px] text-cream-100/50">
                        {w.market_id}
                        {w.signature && (
                          <>
                            {" "}
                            · sig{" "}
                            <a
                              href={`https://solscan.io/tx/${w.signature}`}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="underline-offset-2 hover:underline"
                            >
                              {shortenAddress(w.signature)}
                            </a>
                          </>
                        )}
                      </p>
                      {w.failure_reason && (
                        <p className="mt-0.5 text-[10px] text-no-deep">⚠ {w.failure_reason}</p>
                      )}
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                        w.status === "confirmed"
                          ? "bg-yes/20 text-yes-deep"
                          : w.status === "failed"
                            ? "bg-no/20 text-no-deep"
                            : "bg-cyber-cyan/20 text-cyber-cyan"
                      }`}
                    >
                      {w.status}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink-200/90 px-5 py-3 text-sm font-mono text-cream-100 ring-1 ring-cream-100/15 shadow-glass-lift">
          {toast}
        </div>
      )}
    </main>
  );
}

/* ========================================================================== */

function KeyForm({ onSubmit }: { onSubmit: (k: string) => void }) {
  const [v, setV] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v.trim());
      }}
      className="mt-4 flex gap-2"
    >
      <input
        type="password"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="ADMIN_API_KEY"
        className="flex-1 rounded-2xl bg-cream-200 px-4 py-2.5 font-mono text-sm text-ink-200 ring-1 ring-ink-200/15 outline-none focus:ring-ink-200/40"
      />
      <button
        type="submit"
        className="rounded-2xl bg-ink-200 px-5 py-2.5 text-sm font-semibold text-yes ring-1 ring-yes/40 hover:shadow-yes-glow"
      >
        Enter
      </button>
    </form>
  );
}

function CreateMarketForm({
  onSubmit,
  disabled,
}: {
  onSubmit: (scheduleType: ScheduleType) => void;
  disabled: boolean;
}) {
  const [scheduleType, setScheduleType] = useState<ScheduleType>("hourly");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(scheduleType);
      }}
      className="mt-3 grid grid-cols-1 gap-3 rounded-2xl glass-dark p-4 ring-1 ring-cream-100/10 sm:grid-cols-3"
    >
      <Field label="Schedule">
        <select
          value={scheduleType}
          onChange={(e) => setScheduleType(e.target.value as ScheduleType)}
          className="w-full rounded-xl bg-ink-200/40 px-3 py-2 text-sm font-mono text-cream-100 ring-1 ring-cream-100/10 focus:ring-cream-100/30"
        >
          <option value="15m">15-minute</option>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily 7PM ET</option>
        </select>
      </Field>
      <div className="sm:col-span-1 flex items-end text-xs text-cream-100/55">
        Open MC = live $TROLL MC at insert time. Close = next boundary.
      </div>
      <div className="flex items-end">
        <button
          type="submit"
          disabled={disabled}
          className="w-full rounded-xl bg-yes px-4 py-2.5 text-sm font-semibold text-ink-200 ring-1 ring-yes/40 hover:shadow-yes-glow disabled:opacity-50"
        >
          Create
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-cream-100/55">
        {label}
      </p>
      {children}
    </label>
  );
}

function Stat({ label, value, sub, link }: { label: string; value: string; sub?: string; link?: string }) {
  return (
    <div className="rounded-2xl glass-dark p-4 ring-1 ring-cream-100/10">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-cream-100/55">{label}</p>
      <p className="mt-1 font-display text-xl font-bold tabular-nums text-cream-100">{value}</p>
      {sub && (
        <p className="mt-0.5 truncate font-mono text-[10px] text-cream-100/50">
          {link ? (
            <a href={link} target="_blank" rel="noreferrer noopener" className="underline-offset-2 hover:underline">
              {sub}
            </a>
          ) : (
            sub
          )}
        </p>
      )}
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th className={`px-2.5 py-2 ${align === "right" ? "text-right" : "text-left"} font-mono text-[10px] uppercase tracking-[0.16em]`}>
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  colSpan,
}: {
  children: React.ReactNode;
  align?: "left" | "right" | "center";
  colSpan?: number;
}) {
  const cls = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <td className={`px-2.5 py-2 align-middle text-cream-100 ${cls}`} colSpan={colSpan}>
      {children}
    </td>
  );
}
