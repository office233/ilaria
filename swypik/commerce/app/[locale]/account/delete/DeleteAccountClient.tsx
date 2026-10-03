"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, Download, Loader2 } from "lucide-react";
import { Link } from "@/lib/i18n/navigation";
import { PageHeader } from "@/components/ui/PageHeader";

export default function DeleteAccountClient({ username, hasPassword }: { username: string; hasPassword: boolean }) {
  const t = useTranslations("authEmail.deleteAccount");
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canSubmit = confirm.trim().replace(/^@+/, "").toLowerCase() === username.toLowerCase() && (!hasPassword || password.length > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: confirm.trim(), ...(hasPassword ? { password } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.success) {
        setError(typeof j.error === "string" ? j.error : t("errors.generic"));
        return;
      }
      setDone(true);
    } catch {
      setError(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main className="min-h-dvh bg-canvas text-fg">
        <div className="mx-auto max-w-md px-gutter py-16 text-center">
          <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-success" aria-hidden />
          <h1 className="mb-2 text-2xl font-black">{t("doneTitle")}</h1>
          <p className="mb-8 text-sm text-muted">{t("doneBody")}</p>
          <a href="/" className="inline-flex min-h-[44px] items-center rounded-xl bg-brand px-6 font-bold text-brand-fg">
            {t("home")}
          </a>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-dvh bg-canvas text-fg mobile-page-bottom">
      <PageHeader back="/account/settings" title={t("title")} />
      <main className="mx-auto max-w-md space-y-5 px-gutter py-6">
        <div className="flex gap-3 rounded-2xl border border-danger/30 bg-danger-soft p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden />
          <p className="font-semibold">{t("intro")}</p>
        </div>

        <section className="rounded-2xl border border-subtle bg-surface p-4">
          <h2 className="mb-2 font-bold">{t("whatDeleted")}</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>{t("deleted1")}</li>
            <li>{t("deleted2")}</li>
            <li>{t("deleted3")}</li>
          </ul>
          <h2 className="mb-2 mt-4 font-bold">{t("whatKept")}</h2>
          <p className="text-sm text-muted">{t("kept")}</p>
        </section>

        <section className="rounded-2xl border border-subtle bg-surface p-4 text-sm">
          <p className="mb-3 text-muted">{t("exportHint")}</p>
          <a
            href="/api/account/export"
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-strong px-4 font-semibold"
          >
            <Download className="h-4 w-4" aria-hidden /> {t("exportCta")}
          </a>
        </section>

        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-subtle bg-surface p-4">
          <label className="block text-sm">
            <span className="mb-1 block font-semibold">{t("confirmLabel", { username })}</span>
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="min-h-[44px] w-full rounded-xl border border-strong bg-surface-2 px-3 text-fg outline-none focus:border-danger"
            />
          </label>
          {hasPassword && (
            <label className="block text-sm">
              <span className="mb-1 block font-semibold">{t("passwordLabel")}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="min-h-[44px] w-full rounded-xl border border-strong bg-surface-2 px-3 text-fg outline-none focus:border-danger"
              />
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm font-semibold text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={!canSubmit || busy}
            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-danger px-4 font-bold text-brand-fg transition disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {busy ? t("deleting") : t("submit")}
          </button>
          <Link href="/account/settings" className="block text-center text-sm text-muted underline">
            {t("cancel")}
          </Link>
        </form>
      </main>
    </div>
  );
}
