"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Mail, X, Loader2 } from "lucide-react";

type AuthInfo = {
  authenticated: boolean;
  customer?: {
    email?: string;
    emailVerified?: boolean;
    suspendGraceUntil?: string | null;
  };
};

export default function EmailVerifyBanner() {
  const t = useTranslations("banners");
  const tv = useTranslations("authEmail.banner");
  const tCommon = useTranslations("common");
  const [info, setInfo] = useState<AuthInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(window.sessionStorage.getItem("swypik_dismissed_verify") === "1");
    fetch("/api/auth", { credentials: "include" })
      .then((r) => r.json())
      .then((j) => setInfo(j))
      .catch(() => {});
  }, []);

  if (!info?.authenticated || !info.customer) return null;
  if (info.customer.emailVerified) return null;
  if (dismissed) return null;

  const daysLeft = (() => {
    if (!info.customer.suspendGraceUntil) return null;
    const ms = new Date(info.customer.suspendGraceUntil).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  })();

  async function resend() {
    if (!info?.customer?.email) return;
    setSending(true);
    setFailure(null);
    try {
      // Link de confirmare (NU codul de login): se deschide din inbox și
      // confirmă emailul chiar dacă utilizatorul e deja autentificat.
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resend_verification" }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.sent) {
        setSent(true);
        setTimeout(() => setSent(false), 8000);
      } else if (j.code === "alreadyVerified") {
        setDismissed(true);
      } else {
        setFailure(typeof j.error === "string" ? j.error : tv("failed"));
      }
    } catch {
      setFailure(tv("failed"));
    } finally {
      setSending(false);
    }
  }

  function dismiss() {
    setDismissed(true);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("swypik_dismissed_verify", "1");
    }
  }

  return (
    <div className="sticky top-12 z-30 border-b border-warning/30 bg-warning/10 backdrop-blur-xl">
      <div className="mx-auto flex max-w-lg items-center gap-3 px-3 py-2 text-xs text-fg">
        <Mail className="h-4 w-4 flex-shrink-0 text-warning" />
        <p className="flex-1 leading-snug">
          {failure
            ? failure
            : sent
            ? tv.rich("sent", {
                email: info.customer.email ?? "",
                b: (chunks) => <b>{chunks}</b>,
              })
            : daysLeft !== null && daysLeft <= 7
            ? t("emailVerifyGrace", { count: daysLeft })
            : tv("text")}
        </p>
        <button
          type="button"
          onClick={resend}
          disabled={sending || sent}
          className="rounded-lg bg-warning/20 px-2 py-1 font-bold text-fg hover:bg-warning/30 disabled:opacity-50"
        >
          {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : sent ? t("emailVerifyResendSent") : tv("resend")}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label={tCommon("close")}
          className="rounded-lg p-1 text-fg/70 hover:bg-warning/20 hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
