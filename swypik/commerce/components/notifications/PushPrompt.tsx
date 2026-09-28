"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Bell, X } from "lucide-react";
import { isEnabledClient } from "@/lib/feature-flags-client";
import { isPushSupported, subscribeToPush } from "@/lib/push/subscribe";
import { useTranslations } from "next-intl";

const DISMISS_KEY = "swypik_push_dismissed";
const DISMISS_AT_KEY = "swypik_push_dismissed_at";
const REPROMPT_MS = 7 * 24 * 60 * 60 * 1000;
const HIDE_PREFIXES = ["/auth", "/admin", "/onboarding", "/seller/login"];

/**
 * Global non-intrusive in-app prompt to enable push notifications.
 * Sticky bottom-right (above BottomNav on mobile). Mounted in app/layout.tsx.
 *
 * Hidden if:
 *  - flag pushNotifications off
 *  - browser doesn't support push
 *  - permission already granted or denied
 *  - user not logged in (best-effort cookie sniff)
 *  - dismissed in last 7 days
 *  - on auth/admin/onboarding pages
 */
export default function PushPrompt() {
  const t = useTranslations("pushPrompt");
  const pathname = usePathname() || "/";
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!isEnabledClient("pushNotifications")) return;
    if (!isPushSupported()) return;
    if (HIDE_PREFIXES.some((p) => pathname.startsWith(p))) return;
    if (Notification.permission !== "default") return;

    // Best-effort logged-in heuristic via cookies.
    const ck = typeof document !== "undefined" ? document.cookie : "";
    const loggedIn = /(?:^|; )(swypik_session|swypik_auth|next-auth\.session-token)=/.test(ck);
    if (!loggedIn) return;

    try {
      if (window.localStorage.getItem(DISMISS_KEY) === "1") {
        const at = Number(window.localStorage.getItem(DISMISS_AT_KEY) || "0");
        if (at && Date.now() - at < REPROMPT_MS) return;
      }
    } catch {
      /* no-op */
    }

    // Small delay so it doesn't pop on first paint.
    const t = window.setTimeout(() => setVisible(true), 2500);
    return () => window.clearTimeout(t);
  }, [pathname]);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
      window.localStorage.setItem(DISMISS_AT_KEY, String(Date.now()));
    } catch {
      /* no-op */
    }
    setVisible(false);
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    const res = await subscribeToPush();
    setBusy(false);
    if (res.ok) {
      setToast("Notificările sunt active");
      try {
        window.localStorage.removeItem(DISMISS_KEY);
        window.localStorage.removeItem(DISMISS_AT_KEY);
      } catch {
        /* no-op */
      }
      window.setTimeout(() => {
        setToast(null);
        setVisible(false);
      }, 1800);
    } else if (res.reason === "denied") {
      setToast("Permisiune refuzată");
      window.setTimeout(() => {
        setToast(null);
        setVisible(false);
      }, 1800);
    } else {
      setToast("A eșuat. Încearcă din nou.");
      window.setTimeout(() => setToast(null), 2200);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, dismiss]);

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="push-prompt-title"
      className="fixed left-3 right-3 z-[60] sm:left-auto sm:right-4 sm:max-w-sm"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 72px)" }}
    >
      <div className="relative flex items-start gap-3 rounded-2xl border border-[#7C3AED]/40 bg-gradient-to-br from-[#1a0b2e] to-[#0a0a0a] p-4 shadow-2xl shadow-[#7C3AED]/20 backdrop-blur">
        <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[#7C3AED]/30 text-white">
          <Bell size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p id="push-prompt-title" className="text-sm font-black text-white">
            
            {t("activeazaNotificarile")}
          </p>
          <p className="mt-0.5 text-xs text-white/70">
            
            {t("primesteAlerteDespreNoi")}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={enable}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#7C3AED] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#6d28d9] disabled:opacity-60"
            >
              <Bell size={12} />
              {busy ? "Se conectează…" : "Activează"}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="rounded-lg px-3 py-1.5 text-xs font-bold text-white/70 hover:bg-white/5 hover:text-white"
            >
              
              {t("maiTarziu")}
            </button>
            {toast && <span className="ml-1 text-xs text-white/80">{toast}</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("inchide")}
          className="absolute right-2 top-2 rounded-full p-1 text-white/50 hover:bg-white/10 hover:text-white"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
