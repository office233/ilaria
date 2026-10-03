"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";

type Consent = {
  essential: true;
  analytics: boolean;
  marketing: boolean;
  ts: number;
};

const STORAGE_KEY = "swypik_cookie_consent";

function readConsent(): Consent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.essential) return parsed as Consent;
    return null;
  } catch {
    return null;
  }
}

function writeConsent(consent: Consent) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(consent));
  } catch {
    /* noop */
  }
  try {
    window.dispatchEvent(new CustomEvent("swypik:consent", { detail: consent }));
  } catch {
    /* noop */
  }
}

export default function CookieBanner() {
  const t = useTranslations("cookies");
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [isEU, setIsEU] = useState(true);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (readConsent()) return;

    let cancelled = false;
    setVisible(true);

    fetch("/api/geo", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { isEU?: boolean }) => {
        if (cancelled) return;
        const eu = j?.isEU !== false;
        setIsEU(eu);
        // Non-EU: defaults ON (opt-out). EU: defaults OFF (opt-in).
        if (!eu) {
          setAnalytics(true);
          setMarketing(true);
        }
      })
      .catch(() => {
        if (!cancelled) setIsEU(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!mounted || !visible) return null;

  const persist = (a: boolean, m: boolean) => {
    writeConsent({ essential: true, analytics: a, marketing: m, ts: Date.now() });
    setVisible(false);
  };

  const acceptAll = () => persist(true, true);
  const onlyEssential = () => persist(false, false);
  const saveCustom = () => persist(analytics, marketing);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="cookie-banner-title"
      className="pointer-events-none fixed inset-x-0 z-overlay px-3"
      style={{ bottom: "calc(var(--bottom-inset) + 8px)" }}
    >
      <div className="pointer-events-auto mx-auto w-full max-w-2xl animate-scale-in rounded-card border border-subtle bg-elevated p-4 text-sm text-fg shadow-elev-3">
        <h2 id="cookie-banner-title" className="mb-1 text-base font-semibold">
          {t("title")}
        </h2>
        <p className="leading-snug text-muted">
          {t("description")}
          {isEU ? ` ${t("gdprNote")}` : ""}
        </p>

        {showDetails && (
          <div className="mt-3 space-y-2">
            <ToggleRow label={t("essential")} description={t("essentialDesc")} checked locked />
            <ToggleRow label={t("analytics")} description={t("analyticsDesc")} checked={analytics} onChange={setAnalytics} />
            <ToggleRow label={t("marketing")} description={t("marketingDesc")} checked={marketing} onChange={setMarketing} />
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={acceptAll}>
            {t("acceptAll")}
          </Button>
          <Button size="sm" variant="secondary" onClick={onlyEssential}>
            {t("essentialOnly")}
          </Button>
          {showDetails ? (
            <Button size="sm" variant="ghost" onClick={saveCustom}>
              {t("savePreferences")}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setShowDetails(true)}>
              {t("detailedSettings")}
            </Button>
          )}
          <Link href="/legal/cookies" className="inline-flex min-h-9 items-center px-2 text-muted underline-offset-2 hover:text-fg hover:underline">
            {t("learnMore")}
          </Link>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  locked,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange?: (v: boolean) => void;
  locked?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 rounded-control bg-surface-2 p-3">
      <span className="flex-1">
        <label htmlFor={id} className="block font-medium">
          {label}
        </label>
        <span className="block text-xs text-muted">{description}</span>
      </span>
      <Switch id={id} checked={checked} disabled={locked} onCheckedChange={(v) => onChange?.(v)} />
    </div>
  );
}
