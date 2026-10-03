"use client";

import { useState } from "react";
import Image from "next/image";
import { Loader2, Lock, CheckCircle2, AlertCircle, ShieldCheck, ShieldOff, Copy, Download } from "lucide-react";
import { useTranslations, useLocale } from "next-intl";
import { apiErrorMessage } from "@/lib/i18n/api-error";

export default function SecurityPageClient({
  hasPassword,
  totpEnabled,
  connectedAccounts,
}: {
  hasPassword: boolean;
  totpEnabled: boolean;
  connectedAccounts: { provider: string; email: string | null; createdAt: string }[];
}) {
  const t = useTranslations("security");
  const locale = useLocale();
  const [accounts, setAccounts] = useState(connectedAccounts);
  const [accLoading, setAccLoading] = useState<string | null>(null);
  const [accError, setAccError] = useState<string | null>(null);

  async function disconnectProvider(provider: string) {
    setAccError(null);
    if (!window.confirm(`Sigur deconectezi ${provider}?`)) return;
    setAccLoading(provider);
    try {
      const res = await fetch(`/api/users/me/oauth/${provider}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAccError(data.error || "Nu am putut deconecta.");
        return;
      }
      setAccounts((prev) => prev.filter((a) => a.provider !== provider));
    } finally {
      setAccLoading(null);
    }
  }

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [show, setShow] = useState(false);

  // 2FA state
  const [twoFaEnabled, setTwoFaEnabled] = useState(totpEnabled);
  const [twoFaStep, setTwoFaStep] = useState<"idle" | "setup" | "codes" | "disable">("idle");
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [otpAuthUrl, setOtpAuthUrl] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [disablePw, setDisablePw] = useState("");
  const [twoFaLoading, setTwoFaLoading] = useState(false);
  const [twoFaError, setTwoFaError] = useState<string | null>(null);
  const [regenPw, setRegenPw] = useState("");
  const [showRegen, setShowRegen] = useState(false);

  async function regenerateBackupCodes() {
    setTwoFaError(null);
    if (!regenPw) {
      setTwoFaError("Introdu parola.");
      return;
    }
    setTwoFaLoading(true);
    try {
      const r = await fetch("/api/users/me/2fa/regenerate-backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: regenPw }),
      });
      const j = await r.json();
      if (!r.ok) {
        setTwoFaError(apiErrorMessage(j, locale, t("eroareLaRegenerare")));
        return;
      }
      setBackupCodes(j.backup_codes || []);
      setTwoFaStep("codes");
      setShowRegen(false);
      setRegenPw("");
    } finally {
      setTwoFaLoading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (password.length < 8) {
      setError(t("parolaMinim8"));
      return;
    }
    if (password !== confirm) {
      setError(t("paroleleNuSePotrivesc"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_password", password }),
      });
      const j = await res.json();
      if (!res.ok || !j.success) {
        setError(j.error || t("nuAmPututSalvaParola"));
        return;
      }
      setInfo(t("parolaSalvata"));
      setPassword("");
      setConfirm("");
    } catch {
      setError(t("eroareDeConexiune"));
    } finally {
      setLoading(false);
    }
  }

  async function init2fa() {
    setTwoFaError(null);
    setTwoFaLoading(true);
    try {
      const r = await fetch("/api/users/me/2fa/init", { method: "POST" });
      const j = await r.json();
      if (!r.ok) {
        setTwoFaError(j.error || t("nuAmPututInitializa2fa"));
        return;
      }
      setQrUrl(j.qrCodeDataUrl);
      setOtpAuthUrl(j.otpAuthUrl);
      setTwoFaStep("setup");
    } finally {
      setTwoFaLoading(false);
    }
  }

  async function enable2fa() {
    setTwoFaError(null);
    if (!/^\d{6}$/.test(setupToken)) {
      setTwoFaError(t("introduCodul6Cifre"));
      return;
    }
    setTwoFaLoading(true);
    try {
      const r = await fetch("/api/users/me/2fa/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: setupToken }),
      });
      const j = await r.json();
      if (!r.ok) {
        setTwoFaError(apiErrorMessage(j, locale, t("codInvalid")));
        return;
      }
      setBackupCodes(j.backup_codes || []);
      setTwoFaEnabled(true);
      setTwoFaStep("codes");
      setSetupToken("");
    } finally {
      setTwoFaLoading(false);
    }
  }

  async function disable2fa() {
    setTwoFaError(null);
    if (!disablePw) {
      setTwoFaError(t("introduParola"));
      return;
    }
    setTwoFaLoading(true);
    try {
      const r = await fetch("/api/users/me/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: disablePw }),
      });
      const j = await r.json();
      if (!r.ok) {
        setTwoFaError(apiErrorMessage(j, locale, t("eroareLaDezactivare")));
        return;
      }
      setTwoFaEnabled(false);
      setTwoFaStep("idle");
      setDisablePw("");
    } finally {
      setTwoFaLoading(false);
    }
  }

  function downloadCodes() {
    const blob = new Blob([`${t("backupCodesFileHeader")}\n\n${backupCodes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "swypik-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto max-w-md p-5 text-white">
      <h1 className="mb-2 text-2xl font-black">{t("securitate")}</h1>
      <p className="mb-6 text-sm text-white/60">
        {hasPassword
          ? t("schimbaParolaContului")
          : t("seteazaOParolaCaSa")}
      </p>

      {error && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-[#7C3AED]/30 bg-[#7C3AED]/10 p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 text-[#7C3AED]" />
          <p className="text-sm font-semibold">{error}</p>
        </div>
      )}
      {info && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-[#10A37F]/30 bg-[#10A37F]/10 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 text-[#10A37F]" />
          <p className="text-sm font-semibold">{info}</p>
        </div>
      )}

      <form onSubmit={submit} className="space-y-4">
        <PasswordField
          label={hasPassword ? t("parolaNoua") : t("parola")}
          value={password}
          onChange={setPassword}
          show={show}
          toggle={() => setShow((s) => !s)}
        />
        <PasswordField
          label={t("confirmaParola")}
          value={confirm}
          onChange={setConfirm}
          show={show}
          toggle={() => setShow((s) => !s)}
        />
        <button
          type="submit"
          disabled={loading || !password || !confirm}
          className="flex h-14 w-full items-center justify-center rounded-2xl bg-[#7C3AED] text-base font-black text-white transition active:scale-[0.98] disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : t("salveazaParola")}
        </button>
      </form>

      {/* 2FA Section */}
      <section className="mt-10 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck size={18} className={twoFaEnabled ? "text-[#10A37F]" : "text-white/60"} />
            <h2 className="text-base font-black">{t("autentificareInDoiPasi")}</h2>
          </div>
          {twoFaEnabled && (
            <span className="rounded-full bg-[#10A37F]/20 px-2 py-0.5 text-[10px] font-bold text-[#10A37F]">
              
              {t("activa")}
            </span>
          )}
        </div>
        <p className="mb-4 text-xs text-white/60">
          
          {t("folosesteOAplicatieCa")}
        </p>

        {twoFaError && (
          <div className="mb-3 rounded-xl border border-[#7C3AED]/30 bg-[#7C3AED]/10 p-3 text-xs font-semibold">
            {twoFaError}
          </div>
        )}

        {twoFaStep === "idle" && !twoFaEnabled && (
          <button
            onClick={init2fa}
            disabled={twoFaLoading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 py-3 text-sm font-black hover:bg-white/15 disabled:opacity-50"
          >
            {twoFaLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>{t("activeaza2fa")}</>}
          </button>
        )}

        {twoFaStep === "idle" && twoFaEnabled && (
          <div className="space-y-2">
            <button
              onClick={() => setTwoFaStep("disable")}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#7C3AED]/10 py-3 text-sm font-black text-[#7C3AED] hover:bg-[#7C3AED]/20"
            >
              <ShieldOff size={14} />  {t("dezactiveaza2fa")}
            </button>
            {!showRegen ? (
              <button
                onClick={() => setShowRegen(true)}
                className="w-full rounded-xl bg-white/5 py-2.5 text-xs font-bold text-white/70 hover:bg-white/10"
              >
                
                {t("regenereazaCodurileDeRezerva")}
              </button>
            ) : (
              <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.04] p-3">
                <p className="text-xs text-white/70">
                  
                  {t("vechileCoduriVorFi")}
                </p>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={regenPw}
                  onChange={(e) => setRegenPw(e.target.value)}
                  placeholder={t("parolaContului")}
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-[#7C3AED]"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => { setShowRegen(false); setRegenPw(""); }}
                    className="flex-1 rounded-lg bg-white/10 py-2 text-xs font-bold hover:bg-white/15"
                  >
                    
                    {t("anuleaza")}
                  </button>
                  <button
                    onClick={regenerateBackupCodes}
                    disabled={twoFaLoading}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#7C3AED] py-2 text-xs font-bold disabled:opacity-50"
                  >
                    {twoFaLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : t("genereaza")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {twoFaStep === "setup" && qrUrl && (
          <div className="space-y-3">
            <p className="text-xs text-white/70">{t("scaneazaQrulCuAplicatia")}</p>
            <div className="flex justify-center rounded-xl bg-white p-3">
              <Image src={qrUrl} alt="QR Code 2FA" width={192} height={192} className="h-48 w-48" unoptimized />
            </div>
            {otpAuthUrl && (
              <details className="rounded-lg bg-white/5 p-3 text-xs">
                <summary className="cursor-pointer font-bold text-white/70">{t("nuPotiScanaIntrodu")}</summary>
                <p className="mt-2 break-all text-white/50">{otpAuthUrl}</p>
              </details>
            )}
            <input
              type="text"
              name="otp"
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value.replace(/\D/g, ""))}
              placeholder={t("cod6Cifre")}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-xl tracking-[0.4em] font-bold focus:outline-none focus:border-[#7C3AED]"
            />
            <button
              onClick={enable2fa}
              disabled={twoFaLoading || setupToken.length !== 6}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#7C3AED] py-3 text-sm font-black hover:bg-[#E0264A] disabled:opacity-50"
            >
              {twoFaLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : t("confirmaSiActiveaza")}
            </button>
            <button
              onClick={() => setTwoFaStep("idle")}
              className="w-full text-xs text-white/50 hover:text-white"
            >
              
              {t("anuleaza2")}
            </button>
          </div>
        )}

        {twoFaStep === "codes" && (
          <div className="space-y-3">
            <div className="rounded-xl border border-[#10A37F]/30 bg-[#10A37F]/10 p-3">
              <p className="mb-1 text-sm font-black text-[#10A37F]">{t("2faActiva")}</p>
              <p className="text-xs text-white/70">
                
                {t("salveazaAcesteCoduriDe")}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-black/40 p-3 font-mono text-sm">
              {backupCodes.map((c) => (
                <div key={c} className="text-center text-white/90">{c}</div>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => navigator.clipboard?.writeText(backupCodes.join("\n"))}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-white/10 py-2 text-xs font-bold hover:bg-white/15"
              >
                <Copy size={12} />  {t("copiaza")}
              </button>
              <button
                onClick={downloadCodes}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-white/10 py-2 text-xs font-bold hover:bg-white/15"
              >
                <Download size={12} />  {t("descarcaTxt")}
              </button>
            </div>
            <button
              onClick={() => setTwoFaStep("idle")}
              className="w-full rounded-xl bg-[#10A37F] py-3 text-sm font-black hover:bg-[#0E906F]"
            >
              {t("leAmSalvat")}
            </button>
          </div>
        )}

        {twoFaStep === "disable" && (
          <div className="space-y-3">
            <p className="text-xs text-white/70">{t("confirmaParolaPentruA")}</p>
            <input
              type="password"
              autoComplete="current-password"
              value={disablePw}
              onChange={(e) => setDisablePw(e.target.value)}
              placeholder={t("parolaContului2")}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm focus:outline-none focus:border-[#7C3AED]"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setTwoFaStep("idle")}
                className="flex-1 rounded-xl bg-white/10 py-3 text-sm font-bold hover:bg-white/15"
              >
                
                {t("anuleaza3")}
              </button>
              <button
                onClick={disable2fa}
                disabled={twoFaLoading}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#7C3AED] py-3 text-sm font-black hover:bg-[#E0264A] disabled:opacity-50"
              >
                {twoFaLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : t("dezactiveaza")}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="mt-10 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-lg font-black">{t("conturiConectate")}</h2>
        <p className="mt-1 text-sm text-white/60">{t("loginSocialActivPentru")}</p>
        {accError && (
          <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{accError}</div>
        )}
        {accounts.length === 0 ? (
          <p className="mt-4 text-sm text-white/50">{t("nuAiConturiSociale")}</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {accounts.map((a) => (
              <li key={a.provider} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div>
                  <div className="text-sm font-bold capitalize">{a.provider}</div>
                  {a.email && <div className="text-xs text-white/50">{a.email}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => disconnectProvider(a.provider)}
                  disabled={accLoading === a.provider}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-bold text-white/80 hover:border-rose-500/40 hover:text-rose-200 disabled:opacity-50"
                >
                  {accLoading === a.provider ? "…" : t("deconecteaza")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Confidențialitate — dreptul de acces și portabilitate (GDPR art. 15, 20).
          Politica promitea „să primești o copie" din 31 iulie; până acum nu
          exista niciun mecanism. Descărcarea e directă, fără cerere pe email. */}
      <section className="mt-10 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-lg font-black">{t("confidentialitate")}</h2>
        <p className="mt-1 text-sm text-white/60">{t("descarcaDateleDescriere")}</p>
        <a
          href="/api/account/export"
          download
          className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-bold text-white hover:border-[#7C3AED]/50"
        >
          <Download className="h-4 w-4" />
          {t("descarcaDatele")}
        </a>
        <p className="mt-3 text-xs text-white/40">{t("stergereContNota")}</p>
      </section>
    </main>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  show,
  toggle,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  toggle: () => void;
}) {
  const t = useTranslations("security");
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-white/60">
        {label}
      </span>
      <span className="relative block">
        <Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-white/40" />
        <input
          type={show ? "text" : "password"}
          autoComplete="new-password"
          minLength={8}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="••••••••"
          className="w-full rounded-2xl border border-white/10 bg-white/[0.04] py-4 pl-12 pr-16 text-base text-white outline-none focus:border-[#7C3AED] focus:ring-2 focus:ring-[#7C3AED]/30"
        />
        <button
          type="button"
          onClick={toggle}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-xs font-bold text-white/60 hover:text-white"
        >
          {show ? t("ascunde") : t("arata")}
        </button>
      </span>
    </label>
  );
}
