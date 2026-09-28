"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import EnablePushButton from "@/components/push/EnablePushButton";
import { isEnabledClient } from "@/lib/feature-flags-client";
import { useTranslations } from "next-intl";

const DISMISS_KEY = "swypik:push-prompt-dismissed";

/**
 * PushNotificationCard
 * Shows a compact prompt to enable web push notifications. Hides itself when:
 *   - the FEATURE_PUSH_NOTIFICATIONS client flag is off
 *   - the browser doesn't support notifications
 *   - permission has already been granted (subscription presumably exists)
 *   - permission was denied
 *   - the user has dismissed the prompt (persisted in localStorage)
 *
 * This is the visible mount point requested in FAZA-A2 / Feature 3.
 */
export default function PushNotificationCard() {
  const t = useTranslations("pushPrompt");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isEnabledClient("pushNotifications")) return;
    if (typeof window === "undefined") return;

    const supported =
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    if (!supported) return;

    if (Notification.permission === "granted") return;
    if (Notification.permission === "denied") return;
    if (window.localStorage.getItem(DISMISS_KEY) === "1") return;

    setVisible(true);

    // Re-check periodically: if user grants permission via the button, hide.
    const onVis = () => {
      if (Notification.permission === "granted" || Notification.permission === "denied") {
        setVisible(false);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* no-op */
    }
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <div className="relative mb-4 flex items-start gap-3 rounded-2xl border border-[#7C3AED]/30 bg-gradient-to-br from-[#7C3AED]/15 to-[#EC4899]/10 p-4">
      <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[#7C3AED]/30 text-white">
        <Bell size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-black text-white">{t("cardTitle")}</p>
        <p className="mt-0.5 text-xs text-white/60">
          {t("cardSubtitle")}
        </p>
        <div className="mt-3">
          <EnablePushButton className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-[#0D0D0D] hover:bg-white/90" />
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("close")}
        className="absolute right-2 top-2 rounded-full p-1 text-white/50 hover:bg-white/10 hover:text-white"
      >
        <X size={14} />
      </button>
    </div>
  );
}
