"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

export default function ForgotPasswordPage() {
  const t = useTranslations("authForgot");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "forgot_password", email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || t("genericError"));
      } else {
        setDone(true);
      }
    } catch {
      setError(t("networkError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-black text-white px-4">
      <div className="w-full max-w-md bg-white/5 border border-white/10 rounded-2xl p-6">
        <h1 className="text-2xl font-semibold mb-2">{t("title")}</h1>
        <p className="text-white/60 text-sm mb-6">{t("subtitle")}</p>
        {done ? (
          <div className="space-y-4">
            <div className="bg-violet-500/10 border border-violet-500/30 rounded-lg p-4 text-sm">
              {t("doneMessage")}
            </div>
            <Link href="/auth" className="block text-center text-violet-400 hover:underline text-sm">
              {t("backToLogin")}
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <label className="block">
              <span className="block text-sm mb-1">{t("email")}</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 outline-none focus:border-violet-500"
              />
            </label>
            {error && <div className="text-red-400 text-sm">{error}</div>}
            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-lg py-2 font-medium"
            >
              {loading ? t("sending") : t("submit")}
            </button>
            <Link href="/auth" className="block text-center text-white/60 hover:underline text-sm">
              {t("backToLogin")}
            </Link>
          </form>
        )}
      </div>
    </main>
  );
}
