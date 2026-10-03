"use client";

import { useEffect } from "react";

const ATTR = "data-feed-prefetch";

/** `cors` = cerut ca XHR-ul hls.js (manifest); fără `cors` = ca un `<img>` (poster). */
export type PrefetchHint = { href: string; cors: boolean };

const encode = (h: PrefetchHint) => `${h.cors ? "c" : "n"}|${h.href}`;

/**
 * Pentru clipurile de după vecinul preîncărcat (fără player atașat) încălzim
 * cache-ul HTTP cu manifestul HLS și posterul, prin `<link rel="prefetch">`:
 * prioritate minimă (nu concurează cu clipul activ) și fără avertismentele
 * „preloaded but not used” când userul nu mai derulează. Modul CORS e același
 * cu al cererii reale, ca intrarea din cache să fie refolosită.
 */
export function useFeedPrefetch(hints: readonly PrefetchHint[]): void {
  const key = hints.map(encode).join("\n");

  useEffect(() => {
    const wanted = new Set(key ? key.split("\n") : []);
    document.head.querySelectorAll<HTMLLinkElement>(`link[${ATTR}]`).forEach((link) => {
      const id = link.getAttribute(ATTR) ?? "";
      if (wanted.has(id)) wanted.delete(id);
      else link.remove();
    });
    wanted.forEach((id) => {
      const [mode, ...rest] = id.split("|");
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = rest.join("|");
      if (mode === "c") link.crossOrigin = "anonymous";
      link.setAttribute(ATTR, id);
      document.head.appendChild(link);
    });
  }, [key]);

  useEffect(
    () => () => {
      document.head.querySelectorAll(`link[${ATTR}]`).forEach((link) => link.remove());
    },
    [],
  );
}
