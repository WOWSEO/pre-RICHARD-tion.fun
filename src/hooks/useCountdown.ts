import { useEffect, useState } from "react";

interface Countdown {
  totalMs: number;
  hh: string;
  mm: string;
  ss: string;
  expired: boolean;
}

/** Returns a live HH:MM:SS countdown to `target`, ticked every second. */
export function useCountdown(target: Date): Countdown {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const totalMs = Math.max(0, target.getTime() - now);
  const totalSec = Math.floor(totalMs / 1000);
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return { totalMs, hh, mm, ss, expired: totalMs <= 0 };
}
