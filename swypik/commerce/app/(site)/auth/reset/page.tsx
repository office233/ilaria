"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";

function ResetInner() {
  const t = useTranslations("authReset");
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") || "";
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError(t("tokenLipsa"));
      return;
    }
    if (pw.length < 8) {
      setError(t("minim8"));
      return;
    }
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
      setError(t("litereSiCifre"));
      return;
    }
    if (pw !== pw2) {
      setError(t("parolaNoCoincid"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset_password", token, newPassword: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        setError(data?.error || t("tokenInvalid"));
      } else {
        setDone(true);
        setTimeout(() => router.push("/auth"), 2500);
      }
    } catch {
      setError(t("eroareRetea"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-black text-white px-4">
      <div className="w-full max-w-md bg-white/5 border border-white/10 rounded-2xl p-6">
        <h1 className="text-2xl font-semibold mb-2">{t("titlu")}</h1>
        <p className="text-white/60 text-sm mb-6">
          {t("descriere")}
        </p>
        {done ? (
          <div className="space-y-4">
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 text-sm">
              {t("parolaActualizata")}
            </div>
            <Link href="/auth" className="block text-center text-violet-400 hover:underline text-sm">
              {t("mergiAuth")}
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <label className="block">
              <span className="block text-sm mb-1">{t("parolaNouaLabel")}</span>
              <input
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
                className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 outline-none focus:border-violet-500"
              />
            </label>
            <label className="block">
              <span className="block text-sm mb-1">{t("confirmaParola")}</span>
              <input
                type="password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
                className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 outline-none focus:border-violet-500"
              />
            </label>
            {error && <div className="text-red-400 text-sm">{error}</div>}
            <button
              type="submit"
              disabled={loading || !pw || !pw2}
              className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-lg py-2 font-medium"
            >
              {loading ? t("seSalveaza") : t("reseteazaParola")}
            </button>
            <Link href="/auth" className="block text-center text-white/60 hover:underline text-sm">
              {t("inapoiAuth")}
            </Link>
          </form>
        )}
      </div>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-black" />}>
      <ResetInner />
    </Suspense>
  );
}
