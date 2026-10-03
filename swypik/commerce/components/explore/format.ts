import { useEffect, useState } from "react";

/** 1234 → „1,2 K” în limba viewerului. */
export function compactCount(n: number, locale: string): string {
  const safe = Number.isFinite(n) ? Math.max(0, n) : 0;
  try {
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(safe);
  } catch {
    return String(safe);
  }
}

/** true dacă sistemul cere animații reduse (fără autoplay, fără tranziții decorative). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}
