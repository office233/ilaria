"use client";

import { useCallback, useEffect, useState } from "react";
import { Smartphone, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { matchesRoute } from "@/lib/nav/visibility";
import {
  STORAGE,
  countPageView,
  countVisit,
  readDismissedAt,
  shouldOfferInstall,
} from "@/lib/pwa/install-gate";

const HIDE_ROUTES = ["/auth", "/admin", "/onboarding", "/seller/login", "/checkout"];

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Banner „Instalează aplicația” — apare DOAR după ce utilizatorul a ales la
 * bannerul de cookie și după implicare (a 2-a vizită sau 3 pagini), deci nu
 * se mai suprapune niciodată cu CookieBanner. Regula: lib/pwa/install-gate.ts.
 */
export default function InstallPrompt() {
  const t = useTranslations("installPrompt");
  const pathname = usePathname();
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [eligible, setEligible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  // Contoare de implicare + reevaluare la fiecare navigare și la alegerea cookie.
  useEffect(() => {
    const evaluate = () =>
      safe(
        () =>
          shouldOfferInstall({
            consentDecided: Boolean(localStorage.getItem(STORAGE.cookieConsent)),
            visits: countVisit(localStorage, sessionStorage),
            sessionPageViews: Number(sessionStorage.getItem(STORAGE.pageViews) || "0"),
            dismissedAt: readDismissedAt(localStorage),
            now: Date.now(),
          }),
        false,
      );
    safe(() => countPageView(sessionStorage), 0);
    setEligible(evaluate());
    const onConsent = () => setEligible(evaluate());
    window.addEventListener("swypik:consent", onConsent);
    return () => window.removeEventListener("swypik:consent", onConsent);
  }, [pathname]);

  useEffect(() => {
    const onBefore = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setEvt(null);
    window.addEventListener("beforeinstallprompt", onBefore);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBefore);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    safe(() => {
      localStorage.setItem(STORAGE.dismissed, "1");
      localStorage.setItem(STORAGE.dismissedAt, String(Date.now()));
    }, undefined);
    setHidden(true);
  }, []);

  const install = useCallback(async () => {
    if (!evt) return;
    setBusy(true);
    try {
      await evt.prompt();
      const choice = await evt.userChoice;
      if (choice.outcome === "accepted") setEvt(null);
      else dismiss();
    } catch {
      /* promptul nu mai e valid — ignorăm */
    } finally {
      setBusy(false);
    }
  }, [evt, dismiss]);

  const visible = Boolean(evt) && eligible && !hidden && !HIDE_ROUTES.some((r) => matchesRoute(pathname, r));

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
      aria-labelledby="pwa-install-title"
      className="fixed inset-x-3 z-overlay mx-auto max-w-sm animate-scale-in sm:left-4 sm:right-auto"
      style={{ bottom: "calc(var(--bottom-inset) + 12px)" }}
    >
      <div className="relative flex items-start gap-3 rounded-card border border-subtle bg-elevated p-4 text-fg shadow-elev-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
          <Smartphone className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 pr-6">
          <p id="pwa-install-title" className="text-sm font-semibold">
            {t("title")}
          </p>
          <p className="mt-0.5 text-xs text-muted">{t("subtitle")}</p>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={install} loading={busy}>
              {busy ? t("installing") : t("install")}
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              {t("later")}
            </Button>
          </div>
        </div>
        <IconButton label={t("close")} size="sm" className="absolute right-1 top-1" onClick={dismiss}>
          <X aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}
