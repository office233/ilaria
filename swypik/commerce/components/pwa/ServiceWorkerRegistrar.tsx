"use client";

/**
 * Înregistrează service worker-ul PWA (/sw.js) o singură dată, după load.
 * Renderează null — inclus în app/layout.tsx.
 */
import { useEffect } from "react";

export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((err: unknown) => {
          console.warn("[pwa] sw register failed:", (err as Error).message);
        });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
