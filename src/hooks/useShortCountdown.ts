import { useEffect, useState } from "react";

/**
 * Live "Xh Ym" / "Xm Ys" / "Xs" label that ticks every second toward `target`.
 *
 * Used inside the landing-page prediction panel's three market-option buttons
 * — each button shows its own market's countdown to closeAt.
 *
 * Returns "—" when target is null (no market loaded yet).
 * Returns "Closed" when target has passed (v17 user-facing copy — replaces
 * the legacy "locked" string per the higher/lower product rule).
 */
export function useShortCountdown(target: Date | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!target) return "—";
  const ms = target.getTime() - now;
  if (ms <= 0) return "Closed";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
