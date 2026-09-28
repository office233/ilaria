"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * Indexul slide-ului vizibil (≥ 60%) într-un container cu scroll-snap vertical.
 * Slide-urile poartă `data-feed-index`; `itemsKey` se schimbă când lista se
 * schimbă (pagină nouă, alt tab) → observer-ul se reconstruiește pe noduri noi.
 */
export function useActiveIndex(containerRef: RefObject<HTMLElement | null>, itemsKey: string): number {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = Number((entry.target as HTMLElement).dataset.feedIndex);
          if (Number.isFinite(idx)) setActive(idx);
        }
      },
      { root, threshold: 0.6 },
    );
    root.querySelectorAll<HTMLElement>("[data-feed-index]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [containerRef, itemsKey]);

  return active;
}
