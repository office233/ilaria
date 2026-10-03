"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

/**
 * Confirmă emailul printr-un POST (nu la GET-ul paginii: scannerele de linkuri
 * nu rulează JavaScript, deci nu consumă tokenul în locul utilizatorului).
 */
export default function VerifyEmailClient({ token }: { token: string }) {
  const t = useTranslations("authEmail.verifyPage");
  const [state, setState] = useState<"working" | "ok" | "error">(token ? "working" : "error");
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify_email", token }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        setState(r.ok && j?.success ? "ok" : "error");
      })
      .catch(() => setState("error"));
  }, [token]);

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-white/[0.04] p-8 text-center">
        {state === "working" && (
          <>
            <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-brand" aria-hidden />
            <p role="status" className="text-sm text-white/70">
              {t("verifying")}
            </p>
          </>
        )}
        {state === "ok" && (
          <>
            <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-success" aria-hidden />
            <h1 className="mb-2 text-2xl font-black">{t("successTitle")}</h1>
            <p className="mb-6 text-sm text-white/70">{t("successBody")}</p>
          </>
        )}
        {state === "error" && (
          <>
            <AlertTriangle className="mx-auto mb-4 h-12 w-12 text-warning" aria-hidden />
            <h1 className="mb-2 text-2xl font-black">{t("errorTitle")}</h1>
            <p className="mb-6 text-sm text-white/70">{t("errorBody")}</p>
          </>
        )}
        {state !== "working" && (
          <Link
            href="/account"
            className="flex min-h-[48px] w-full items-center justify-center rounded-2xl bg-brand px-4 font-black text-brand-fg transition hover:bg-brand-hover"
          >
            {t("continue")}
          </Link>
        )}
      </div>
    </main>
  );
}
