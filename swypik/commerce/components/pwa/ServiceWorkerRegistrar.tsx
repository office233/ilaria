"use client";

/**
 * Înregistrează service worker-ul PWA (/sw.js) o singură dată, după load.
 * Renderează null — inclus în app/layout.tsx.
 */
import { useEffect } from "react";

export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const version = process.env.NEXT_PUBLIC_SW_VERSION || "dev";
    const scriptUrl = `/sw.js?v=${encodeURIComponent(version)}`;
    const hadController = Boolean(navigator.serviceWorker.controller);
    let disposed = false;
    let reloading = false;

    const onControllerChange = () => {
      // Prima instalare nu trebuie să reîncarce pagina. La update însă,
      // skipWaiting()+clients.claim() schimbă controllerul; reîncărcăm O
      // SINGURĂ dată ca documentul să ia noile chunk-uri.
      if (!hadController || disposed || reloading) return;
      const key = `swypik:sw-reloaded:${version}`;
      try {
        if (window.sessionStorage.getItem(key)) return;
        window.sessionStorage.setItem(key, "1");
      } catch {
        // sessionStorage poate fi blocat; flag-ul in-memory previne loop-ul
        // în această execuție.
      }
      reloading = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register(scriptUrl, {
          scope: "/",
          updateViaCache: "none",
        });
        // Nu așteptăm heuristica browserului (care poate verifica doar periodic).
        await registration.update();
      } catch (err) {
        console.warn("[pwa] sw register/update failed:", (err as Error).message);
      }
    };

    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      disposed = true;
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
