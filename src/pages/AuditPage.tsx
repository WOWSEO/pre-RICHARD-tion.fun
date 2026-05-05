import { Link, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { api, type AuditWire } from "../services/apiClient";

export function AuditPage() {
  const { marketId } = useParams<{ marketId: string }>();
  const [receipt, setReceipt] = useState<AuditWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!marketId) return;
    let cancelled = false;
    setLoading(true);
    api
      .audit(marketId)
      .then((res) => {
        if (!cancelled) {
          setReceipt(res.receipt);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load audit");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [marketId]);

  return (
    <main className="relative min-h-screen px-4 pb-24 pt-28 sm:px-8 sm:pt-32">
      <div className="mx-auto max-w-3xl">
        <Link
          to={`/market/${marketId}`}
          className="inline-flex items-center gap-1.5 text-xs text-cream-100/60 hover:text-yes"
        >
          ← Back to market
        </Link>

        <div className="mt-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-cream-100/60">
            Audit receipt
          </p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tightest text-cream-100 sm:text-4xl break-all">
            {marketId}
          </h1>
        </div>

        {loading && (
          <div className="mt-6 rounded-3xl glass p-8 text-center text-ink-100/70">
            Fetching audit receipt…
          </div>
        )}

        {error && !loading && (
          <div className="mt-6 rounded-3xl glass p-8">
            <p className="font-display text-lg font-bold text-ink-200">No audit receipt yet.</p>
            <p className="mt-2 text-sm text-ink-100/70">
              {error}. The receipt is generated only after the market settles. If close has passed
              and this still says "audit_not_found," check the settlement worker logs.
            </p>
          </div>
        )}

        {receipt && (
          <div className="mt-6 glass scanlines relative overflow-hidden rounded-3xl p-6 shadow-glass sm:p-8">
            <KeyVal k="Question" v={receipt.question} />
            <KeyVal k="Target MC" v={fmtUsd(receipt.target_mc)} mono />
            <KeyVal k="Close at" v={receipt.close_at} mono />
            <KeyVal k="Schedule" v={receipt.schedule_type} mono />

            <div className="my-5 h-px bg-ink-200/15" />

            <KeyVal k="Outcome" v={receipt.outcome} mono uppercase />
            {receipt.void_reason && (
              <KeyVal k="Void reason" v={receipt.void_reason} mono />
            )}
            <KeyVal k="Canonical MC" v={receipt.canonical_mc != null ? fmtUsd(receipt.canonical_mc) : "—"} mono />

            <div className="my-5 h-px bg-ink-200/15" />

            <KeyVal k="Final YES price" v={`${Number.parseFloat(receipt.final_yes_price_cents).toFixed(2)}¢`} mono />
            <KeyVal k="Final NO price" v={`${Number.parseFloat(receipt.final_no_price_cents).toFixed(2)}¢`} mono />

            <div className="my-5 h-px bg-ink-200/15" />

            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/70">
              Per-source medians
            </p>
            <div className="mt-2 overflow-hidden rounded-xl ring-1 ring-ink-200/15">
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(receipt.source_medians).map(([source, mc]) => (
                    <tr key={source} className="border-b border-ink-200/10 last:border-0">
                      <td className="bg-cream-200/95 px-3 py-2 font-mono text-xs text-ink-200">{source}</td>
                      <td className="bg-cream-200/85 px-3 py-2 text-right font-display tabular-nums text-ink-200">
                        {mc != null ? fmtUsd(String(mc)) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="my-5 h-px bg-ink-200/15" />

            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/70">
              Snapshot bundle hash
            </p>
            <p className="mt-1 break-all font-mono text-xs text-ink-200">
              {receipt.snapshot_bundle_hash}
            </p>

            {Array.isArray(receipt.user_settlements) && receipt.user_settlements.length > 0 && (
              <>
                <div className="my-5 h-px bg-ink-200/15" />
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/70">
                  User settlements ({receipt.user_settlements.length})
                </p>
                <div className="mt-2 max-h-64 overflow-y-auto rounded-xl bg-cream-200/95 p-3 ring-1 ring-ink-200/15">
                  <pre className="font-mono text-[10px] text-ink-200 whitespace-pre-wrap break-all">
                    {JSON.stringify(receipt.user_settlements, null, 2)}
                  </pre>
                </div>
              </>
            )}
          </div>
        )}

        <p className="mt-4 text-center text-[11px] text-cream-100/55">
          Audit receipts are deterministic — the same snapshot bundle always produces the same sha256.
        </p>
      </div>
    </main>
  );
}

function KeyVal({
  k,
  v,
  mono,
  uppercase,
}: {
  k: string;
  v: string;
  mono?: boolean;
  uppercase?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-1.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-100/70">{k}</p>
      <p
        className={`text-sm text-ink-200 ${mono ? "font-mono" : "font-display font-semibold"} ${
          uppercase ? "uppercase" : ""
        } break-all text-right`}
      >
        {v}
      </p>
    </div>
  );
}

function fmtUsd(n: string | number): string {
  const v = typeof n === "string" ? Number.parseFloat(n) : n;
  if (!Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}
