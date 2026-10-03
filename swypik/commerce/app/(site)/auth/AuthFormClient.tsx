"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import {
  Loader2,
  Mail,
  KeyRound,
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  Lock,
  User as UserIcon,
  Phone,
  AtSign,
  Handshake,
} from "lucide-react";

type Mode = "login" | "signup";

/** Aceleași reguli ca serverul (lib/social/config USERNAME_RULES). */
const USERNAME_RE = /^[a-z0-9_]{3,30}$/;

type Props = {
  mode: Mode;
  nextPath: string;
};

export default function AuthFormClient({ mode, nextPath }: Props) {
  if (mode === "login") {
    return <LoginForm nextPath={nextPath} />;
  }
  return <SignupWizard nextPath={nextPath} />;
}

/* ════════════════════════════════════════════════════════════════
   LOGIN — tabs (parolă | cod email)
   ════════════════════════════════════════════════════════════════ */

function LoginForm({ nextPath }: { nextPath: string }) {
  const t = useTranslations("authClient");
  const locale = useLocale();
  const router = useRouter();
  const [tab, setTab] = useState<"password" | "otp">("password");
  const [step, setStep] = useState<"email" | "otp_code">("email");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [twoFa, setTwoFa] = useState<{ tempToken: string } | null>(null);
  const [twoFaCode, setTwoFaCode] = useState("");

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "login_password",
          email: email.trim().toLowerCase(),
          password,
          next: nextPath || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || t("emailSauParolaIncorecta"));
        return;
      }
      if (data.requires2FA && data.tempToken) {
        setTwoFa({ tempToken: data.tempToken });
        return;
      }
      const target =
        typeof data.redirectTo === "string" && data.redirectTo.startsWith("/")
          ? data.redirectTo
          : nextPath || "/account";
      window.location.assign(target);
      router.refresh();
    } catch {
      setError(t("eroareDeConexiuneReincearca"));
    } finally {
      setLoading(false);
    }
  }

  async function verify2FA(e: React.FormEvent) {
    e.preventDefault();
    if (!twoFa) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify_2fa", tempToken: twoFa.tempToken, code: twoFaCode.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || t("codInvalid"));
        return;
      }
      const target =
        typeof data.redirectTo === "string" && data.redirectTo.startsWith("/")
          ? data.redirectTo
          : nextPath || "/account";
      window.location.assign(target);
      router.refresh();
    } catch {
      setError(t("eroareDeConexiune"));
    } finally {
      setLoading(false);
    }
  }

  async function sendOtp(action: "login" | "resend_otp") {
    setLoading(true);
    setError(null);
    setInfo(null);
    setDevOtp(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, email: email.trim().toLowerCase(), locale }),
      });
      const data = await res.json();
      if (!res.ok || !data.requiresVerification) {
        setError(data.error || t("nuAmPututTrimiteCodul"));
        return;
      }
      if (data.devOtp) setDevOtp(String(data.devOtp));
      setStep("otp_code");
      setResendCooldown(30);
      if (action === "resend_otp") {
        setInfo(t("amTrimisUnCodNou"));
      }
    } catch {
      setError(t("nuAmPututContactaServerul"));
    } finally {
      setLoading(false);
    }
  }

  async function submitOtp(e: React.FormEvent) {
    e.preventDefault();
    if (otp.length !== 6) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "verify_otp",
          email: email.trim().toLowerCase(),
          token: otp,
          next: nextPath || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || t("codInvalidSauExpirat"));
        return;
      }
      // Cont cu autentificator activ: codul pe email nu ajunge, cerem și TOTP.
      if (data.requires2FA && data.tempToken) {
        setTwoFa({ tempToken: data.tempToken });
        return;
      }
      const target =
        typeof data.redirectTo === "string" && data.redirectTo.startsWith("/")
          ? data.redirectTo
          : nextPath || "/account";
      window.location.assign(target);
      router.refresh();
    } catch {
      setError(t("eroareDeConexiune"));
    } finally {
      setLoading(false);
    }
  }

  if (twoFa) {
    return (
      <div className="min-h-screen bg-canvas text-white flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-3xl bg-white/[0.04] border border-white/10 p-6">
          <h1 className="text-2xl font-black mb-2">{t("verificareInDoiPasi")}</h1>
          <p className="text-sm text-white/60 mb-6">{t("introduCodulDinAplicatie")}</p>
          <form onSubmit={verify2FA} className="space-y-4">
            <input
              type="text"
              name="otp"
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={8}
              autoFocus
              value={twoFaCode}
              onChange={(e) => setTwoFaCode(e.target.value)}
              placeholder={t("placeholder2faCod")}
              className="w-full text-center tracking-[0.3em] text-xl rounded-2xl bg-white/5 border border-white/10 px-4 py-4 font-black text-white outline-none focus:border-brand"
            />
            {error && <p role="alert" className="text-sm font-bold text-danger text-center">{error}</p>}
            <button
              type="submit"
              disabled={loading || twoFaCode.length < 6}
              className="w-full rounded-2xl bg-brand hover:bg-brand-hover py-4 font-black text-white disabled:opacity-50"
            >
              {loading ? t("verificam") : t("confirma")}
            </button>
            <button
              type="button"
              onClick={() => { setTwoFa(null); setTwoFaCode(""); setError(null); }}
              className="w-full text-xs text-white/50 hover:text-white"
            >
              {t("inapoiLaLogin")}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <section className="flex flex-1 flex-col">
      <div className="mb-6">
        <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
          {step === "otp_code" ? t("verificaEmailul") : t("bineAiRevenit")}
        </h1>
        <p className="mt-2 text-sm text-white/60">
          {step === "otp_code" ? (
            <>{t.rich("codulAFostTrimisPe", { email, b: (c) => <b className="text-white">{c}</b> })}</>
          ) : (
            t("intraInCont")
          )}
        </p>
      </div>

      {step === "email" && <OAuthButtons nextPath={nextPath} />}

      {step === "email" && (
        <div className="mb-5 grid grid-cols-2 gap-2 rounded-2xl bg-white/5 p-1">
          <button
            type="button"
            onClick={() => setTab("password")}
            className={`rounded-xl py-3 min-h-[44px] text-sm font-bold transition focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none ${tab === "password" ? "bg-white text-black" : "text-white/60"
              }`}
          >
            {t("parolaTab")}
          </button>
          <button
            type="button"
            onClick={() => setTab("otp")}
            className={`rounded-xl py-3 min-h-[44px] text-sm font-bold transition focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none ${tab === "otp" ? "bg-white text-black" : "text-white/60"
              }`}
          >
            {t("codEmail")}
          </button>
        </div>
      )}

      {error && <ErrorBanner text={error} />}
      {info && !error && <InfoBanner text={info} />}

      {step === "email" && tab === "password" && (
        <form onSubmit={submitPassword} className="space-y-4" noValidate>
          <FieldEmail value={email} onChange={setEmail} />
          <FieldPassword value={password} onChange={setPassword} autoComplete="current-password" />
          <PrimaryButton loading={loading} disabled={!email || !password}>
            {t("intraInContBtn")}
          </PrimaryButton>
          <div className="text-center text-sm">
            <a href="/auth/forgot" className="inline-flex items-center justify-center min-h-[44px] px-3 text-violet-400 hover:underline focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none rounded">{t("aiUitatParola")}</a>
          </div>
        </form>
      )}

      {step === "email" && tab === "otp" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) sendOtp("login");
          }}
          className="space-y-4"
          noValidate
        >
          <FieldEmail value={email} onChange={setEmail} />
          <PrimaryButton loading={loading} disabled={!email.trim()}>
            {t("trimiteCod")}
          </PrimaryButton>
        </form>
      )}

      {step === "otp_code" && (
        <form onSubmit={submitOtp} className="space-y-4" noValidate>
          {devOtp && <DevOtpBanner code={devOtp} />}
          <FieldOtp value={otp} onChange={setOtp} />
          <PrimaryButton loading={loading} disabled={otp.length !== 6}>
            {t("confirma")}
          </PrimaryButton>
          <div className="flex items-center justify-between pt-2 text-sm">
            <button
              type="button"
              onClick={() => {
                setStep("email");
                setOtp("");
                setError(null);
                setInfo(null);
                setDevOtp(null);
              }}
              className="inline-flex items-center gap-1 text-white/60 hover:text-white transition"
            >
              <ArrowLeft className="h-4 w-4" /> {t("schimbaEmailul")}
            </button>
            <button
              type="button"
              disabled={resendCooldown > 0 || loading}
              onClick={() => sendOtp("resend_otp")}
              className="font-bold text-white/70 hover:text-white transition disabled:opacity-50"
            >
              {resendCooldown > 0 ? t("retrimiteIn", { s: resendCooldown }) : t("retrimiteCodul")}
            </button>
          </div>
        </form>
      )}

      <p className="mt-6 text-center text-xs text-white/40">
        {t.rich("continuandAccepti", {
          termeni: (c) => <Link href="/terms" className="inline-block min-h-[44px] py-2.5 underline hover:text-white/70 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none rounded">{c}</Link>,
          privacy: (c) => <Link href="/privacy" className="inline-block min-h-[44px] py-2.5 underline hover:text-white/70 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none rounded">{c}</Link>,
        })}
      </p>

      <PartnerLinks />
    </section>
  );
}

/** Un singur CTA către hub-ul de recrutare parteneri (/join). */
function PartnerLinks() {
  const t = useTranslations("join");
  return (
    <div className="mt-6 border-t border-white/10 pt-5">
      <p className="mb-3 text-center text-[11px] font-extrabold uppercase tracking-widest text-white/40">
        {t("partnerHeading")}
      </p>
      <Link
        href="/join"
        className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-white/10 px-4 py-3 text-sm font-black text-white transition hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"
      >
        <Handshake size={16} /> {t("becomePartnerBtn")}
      </Link>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   SIGNUP WIZARD — 4 steps
   ════════════════════════════════════════════════════════════════ */

type SignupData = {
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  username: string;
  phone: string;
  avatar_url: string;
};

function SignupWizard({ nextPath }: { nextPath: string }) {
  const t = useTranslations("authClient");
  const locale = useLocale();
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [data, setData] = useState<SignupData>({
    email: "",
    password: "",
    first_name: "",
    last_name: "",
    username: "",
    phone: "",
    avatar_url: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameStatus, setUsernameStatus] = useState<
    "idle" | "checking" | "available" | "taken" | "invalid" | "reserved"
  >("idle");

  function update<K extends keyof SignupData>(key: K, value: SignupData[K]) {
    setData((d) => ({ ...d, [key]: value }));
  }

  // Live username check (debounced)
  useEffect(() => {
    if (step !== 3) return;
    const handle = data.username.trim().toLowerCase();
    if (!handle) {
      setUsernameStatus("idle");
      return;
    }
    if (!USERNAME_RE.test(handle)) {
      setUsernameStatus("invalid");
      return;
    }
    setUsernameStatus("checking");
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "check_username", username: handle }),
        });
        const j = await res.json();
        setUsernameStatus(
          j.available ? "available" : j.reason === "username_reserved" ? "reserved" : j.reason === "username_invalid" ? "invalid" : "taken",
        );
      } catch {
        setUsernameStatus("idle");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [data.username, step]);

  function next() {
    setError(null);
    setStep((s) => s + 1);
  }
  function back() {
    setError(null);
    setStep((s) => Math.max(1, s - 1));
  }

  async function submitFinal() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "signup_password",
          email: data.email.trim().toLowerCase(),
          password: data.password,
          first_name: data.first_name.trim(),
          last_name: data.last_name.trim(),
          username: data.username.trim().toLowerCase(),
          phone: data.phone.trim() || undefined,
          avatar_url: data.avatar_url || undefined,
          next: nextPath || undefined,
          locale,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.success) {
        setError(j.error || t("nuAmPututCreaContul"));
        // Sari înapoi la pasul relevant pentru field-ul cu eroare
        if (j.field === "email") setStep(1);
        else if (j.field === "username") { setStep(3); setUsernameStatus(j.code === "usernameReserved" ? "reserved" : "taken"); }
        else if (j.field === "first_name" || j.field === "last_name") setStep(2);
        else if (j.field === "phone") setStep(4);
        return;
      }
      const target =
        typeof j.redirectTo === "string" && j.redirectTo.startsWith("/")
          ? j.redirectTo
          : nextPath || "/account";
      window.location.assign(target);
      router.refresh();
    } catch {
      setError(t("eroareDeConexiune"));
    } finally {
      setLoading(false);
    }
  }

  // Validări per-pas
  const canAdvance =
    step === 1
      ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) && data.password.length >= 8
      : step === 2
        ? data.first_name.trim().length > 0 && data.last_name.trim().length > 0
        : step === 3
          ? usernameStatus === "available"
          : true;

  return (
    <section className="flex flex-1 flex-col">
      <div className="mb-6">
        <p className="text-xs font-bold uppercase tracking-widest text-brand">
          {t("pasDin", { step, total: 4 })}
        </p>
        <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">
          {step === 1 && t("emailParola")}
          {step === 2 && t("cumTeCheama")}
          {step === 3 && t("alegeUnUsername")}
          {step === 4 && t("aproapeGata")}
        </h1>
        <p className="mt-2 text-sm text-white/60">
          {step === 1 && t("folosimEmailulRecuperare")}
          {step === 2 && t("apareProfilulPublic")}
          {step === 3 && t("numeleUnicPrieteni")}
          {step === 4 && t("telefonAvatarOptionale")}
        </p>
      </div>

      <ProgressBar step={step} total={4} />

      {error && <ErrorBanner text={error} />}

      {step === 1 && <OAuthButtons nextPath={nextPath} />}
      {step === 1 && (
        <div className="space-y-4">
          <FieldEmail value={data.email} onChange={(v) => update("email", v)} />
          <FieldPassword
            value={data.password}
            onChange={(v) => update("password", v)}
            autoComplete="new-password"
            hint={t("minim8Caractere")}
          />
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <FieldText
            label={t("prenume")}
            icon={<UserIcon className="h-5 w-5 text-white/40" />}
            value={data.first_name}
            onChange={(v) => update("first_name", v)}
            placeholder="Abel"
            autoComplete="given-name"
          />
          <FieldText
            label={t("nume")}
            icon={<UserIcon className="h-5 w-5 text-white/40" />}
            value={data.last_name}
            onChange={(v) => update("last_name", v)}
            placeholder="Varga"
            autoComplete="family-name"
          />
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <FieldText
            label={t("username")}
            icon={<AtSign className="h-5 w-5 text-white/40" />}
            value={data.username}
            onChange={(v) => update("username", v.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
            placeholder="abel_varga"
            autoComplete="off"
          />
          <UsernameStatus status={usernameStatus} value={data.username} />
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <FieldText
            label={t("telefonOptional")}
            icon={<Phone className="h-5 w-5 text-white/40" />}
            value={data.phone}
            onChange={(v) => update("phone", v)}
            placeholder="+40712345678"
            autoComplete="tel"
            type="tel"
            inputMode="tel"
          />
          <p className="text-xs text-white/40">
            {t("avatarDinCont")}
          </p>
        </div>
      )}

      <div className="mt-6 flex gap-3">
        {step > 1 && (
          <button
            type="button"
            onClick={back}
            className="flex h-14 flex-1 items-center justify-center gap-1 rounded-2xl border border-white/10 bg-white/5 text-sm font-bold text-white/80 transition active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"
          >
            <ArrowLeft className="h-4 w-4" /> {t("inapoi")}
          </button>
        )}
        {step < 4 ? (
          <button
            type="button"
            onClick={next}
            disabled={!canAdvance}
            className="flex h-14 flex-[2] items-center justify-center rounded-2xl bg-brand text-base font-black text-white transition active:scale-[0.98] disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"
          >
            {t("continua")}
          </button>
        ) : (
          <button
            type="button"
            onClick={submitFinal}
            disabled={loading}
            className="flex h-14 flex-[2] items-center justify-center rounded-2xl bg-brand text-base font-black text-white transition active:scale-[0.98] disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : t("creeazaContul")}
          </button>
        )}
      </div>

      <p className="mt-6 text-center text-xs text-white/40">
        {t.rich("continuandAccepti", {
          termeni: (c) => <Link href="/terms" className="inline-block min-h-[44px] py-2.5 underline hover:text-white/70 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none rounded">{c}</Link>,
          privacy: (c) => <Link href="/privacy" className="inline-block min-h-[44px] py-2.5 underline hover:text-white/70 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none rounded">{c}</Link>,
        })}
      </p>

      <PartnerLinks />
    </section>
  );
}

/* ════════════════════════════════════════════════════════════════
   Reusable bits
   ════════════════════════════════════════════════════════════════ */

function ErrorBanner({ text }: { text: string }) {
  return (
    <div
      role="alert"
      className="mb-5 flex items-start gap-3 rounded-2xl border border-danger/40 bg-danger/10 p-4"
    >
      <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-danger" />
      <p className="text-sm font-semibold text-white">{text}</p>
    </div>
  );
}

function InfoBanner({ text }: { text: string }) {
  return (
    <div
      role="status"
      className="mb-5 flex items-start gap-3 rounded-2xl border border-success/40 bg-success/10 p-4"
    >
      <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-success" />
      <p className="text-sm font-semibold text-white">{text}</p>
    </div>
  );
}

function DevOtpBanner({ code }: { code: string }) {
  const t = useTranslations("authClient");
  return (
    <div className="mb-2 rounded-2xl border border-success/40 bg-success/10 p-5 text-center">
      <p className="text-[10px] font-black uppercase tracking-widest text-success">
        {t("codDev")}
      </p>
      <p className="mt-1 font-mono text-3xl font-black tracking-[0.4em] text-white">
        {code}
      </p>
    </div>
  );
}

function FieldEmail({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useTranslations("authClient");
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-white/60">
        {t("emailLabel")}
      </span>
      <span className="relative block">
        <Mail className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-white/40" />
        <input
          type="email"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="nume@email.ro"
          className="min-h-[44px] w-full rounded-2xl border border-white/10 bg-white/[0.04] py-4 pl-12 pr-4 text-base text-white placeholder-white/30 outline-none transition focus:border-brand focus:bg-white/[0.06] focus:ring-2 focus:ring-brand/30"
        />
      </span>
    </label>
  );
}

function FieldPassword({
  value,
  onChange,
  autoComplete,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete: "current-password" | "new-password";
  hint?: string;
}) {
  const [show, setShow] = useState(false);
  const passwordId = useId();
  const t = useTranslations("authClient");
  return (
    <div className="block">
      <label htmlFor={passwordId} className="mb-2 block text-xs font-bold uppercase tracking-widest text-white/60">
        {t("parolaLabel")}
      </label>
      <div className="relative block">
        <Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-white/40" />
        <input
          id={passwordId}
          type={show ? "text" : "password"}
          autoComplete={autoComplete}
          required
          minLength={8}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="••••••••"
          className="min-h-[44px] w-full rounded-2xl border border-white/10 bg-white/[0.04] py-4 pl-12 pr-16 text-base text-white placeholder-white/30 outline-none transition focus:border-brand focus:bg-white/[0.06] focus:ring-2 focus:ring-brand/30"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? t("ascundeParola") : t("arataParola")}
          className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg px-2 py-1 text-xs font-bold text-white/60 hover:bg-white/10 hover:text-white transition focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"
        >
          {show ? t("ascunde") : t("arata")}
        </button>
      </div>
      {hint && <p className="mt-1.5 text-xs text-white/40">{hint}</p>}
    </div>
  );
}

function FieldText({
  label,
  icon,
  value,
  onChange,
  placeholder,
  autoComplete,
  type = "text",
  inputMode,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  type?: string;
  inputMode?: "text" | "email" | "numeric" | "tel" | "url" | "search" | "decimal" | "none";
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-white/60">
        {label}
      </span>
      <span className="relative block">
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2">
          {icon}
        </span>
        <input
          type={type}
          autoComplete={autoComplete}
          inputMode={inputMode}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="min-h-[44px] w-full rounded-2xl border border-white/10 bg-white/[0.04] py-4 pl-12 pr-4 text-base text-white placeholder-white/30 outline-none transition focus:border-brand focus:bg-white/[0.06] focus:ring-2 focus:ring-brand/30"
        />
      </span>
    </label>
  );
}

function FieldOtp({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  const t = useTranslations("authClient");
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-white/60">
        {t("codDe6Cifre")}
      </span>
      <span className="relative block">
        <KeyRound className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-white/40" />
        <input
          ref={ref}
          type="text"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          required
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="000000"
          className="w-full rounded-2xl border border-white/10 bg-white/[0.04] py-4 pl-12 pr-4 text-center font-mono text-2xl font-black tracking-[0.5em] text-white placeholder-white/20 outline-none transition focus:border-brand focus:bg-white/[0.06] focus:ring-2 focus:ring-brand/30"
        />
      </span>
    </label>
  );
}

function PrimaryButton({
  loading,
  disabled,
  children,
}: {
  loading: boolean;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className="flex h-14 w-full items-center justify-center rounded-2xl bg-brand text-base font-black text-white transition active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"
    >
      {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : children}
    </button>
  );
}

function ProgressBar({ step, total }: { step: number; total: number }) {
  return (
    <div className="mb-6 flex gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`h-1.5 flex-1 rounded-full transition ${i < step ? "bg-brand" : "bg-white/10"
            }`}
        />
      ))}
    </div>
  );
}

function UsernameStatus({
  status,
  value,
}: {
  status: "idle" | "checking" | "available" | "taken" | "invalid" | "reserved";
  value: string;
}) {
  const t = useTranslations("authClient");
  if (!value.trim()) return null;
  // aria-live: status updates announced for screen readers

  if (status === "checking") {
    return <p role="status" aria-live="polite" className="text-xs text-white/40">{t("verificamDisponibilitatea")}</p>;
  }
  if (status === "invalid") {
    return (
      <p role="status" aria-live="polite" className="text-xs text-danger">
        {t("usernameInvalidRules")}
      </p>
    );
  }
  if (status === "available") {
    return (
      <p role="status" aria-live="polite" className="flex items-center gap-1 text-xs text-success">
        <CheckCircle2 className="h-3.5 w-3.5" /> {t("usernameDisponibil", { value })}
      </p>
    );
  }
  if (status === "reserved") {
    return (
      <p role="status" aria-live="polite" className="flex items-center gap-1 text-xs text-danger">
        <AlertCircle className="h-3.5 w-3.5" /> {t("usernameRezervat", { value })}
      </p>
    );
  }
  if (status === "taken") {
    return (
      <p role="status" aria-live="polite" className="flex items-center gap-1 text-xs text-danger">
        <AlertCircle className="h-3.5 w-3.5" /> {t("usernameDejaFolosit", { value })}
      </p>
    );
  }
  return null;
}

function OAuthButtons({ nextPath }: { nextPath: string }) {
  const t = useTranslations("authClient");
  const googleEnabled = process.env.NEXT_PUBLIC_OAUTH_GOOGLE_ENABLED === "1";
  const appleEnabled = process.env.NEXT_PUBLIC_OAUTH_APPLE_ENABLED === "1";
  if (!googleEnabled && !appleEnabled) return null;
  const next = encodeURIComponent(nextPath || "/");
  return (
    <div className="mb-5">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {googleEnabled && (<a
          href={`/api/auth/oauth/google/start?next=${next}`}
          className="flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-bold text-black transition hover:bg-white/90"
          aria-label={t("continuaCuGoogle")}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M21.6 12.227c0-.709-.064-1.39-.182-2.045H12v3.868h5.382a4.6 4.6 0 0 1-1.996 3.018v2.51h3.232c1.891-1.741 2.982-4.305 2.982-7.351z" />
            <path fill="#34A853" d="M12 22c2.7 0 4.964-.895 6.618-2.422l-3.232-2.51c-.895.6-2.041.955-3.386.955-2.605 0-4.81-1.759-5.595-4.122H3.064v2.59A9.996 9.996 0 0 0 12 22z" />
            <path fill="#FBBC05" d="M6.405 13.9a6.005 6.005 0 0 1 0-3.8V7.51H3.064a9.996 9.996 0 0 0 0 8.98l3.341-2.59z" />
            <path fill="#EA4335" d="M12 5.977c1.468 0 2.786.505 3.823 1.496l2.868-2.868C16.96 2.99 14.696 2 12 2A9.996 9.996 0 0 0 3.064 7.51l3.341 2.59C7.19 7.736 9.395 5.977 12 5.977z" />
          </svg>
          {t("continuaCuGoogle")}
        </a>)}
        {appleEnabled && (<a
          href={`/api/auth/oauth/apple/start?next=${next}`}
          className="flex items-center justify-center gap-2 rounded-xl bg-black px-4 py-3 text-sm font-bold text-white ring-1 ring-white/15 transition hover:bg-white/5"
          aria-label={t("continuaCuApple")}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16.365 1.43c0 1.14-.4 2.218-1.198 3.222-.962 1.193-2.131 1.886-3.396 1.787a3.49 3.49 0 0 1-.027-.443c0-1.094.466-2.262 1.292-3.225C13.46.83 14.586.135 15.97 0c.027.144.038.289.038.443zM20.5 17.05c-.622 1.437-.92 2.078-1.722 3.348-1.12 1.77-2.7 3.97-4.658 3.987-1.74.016-2.188-1.13-4.55-1.117-2.362.013-2.854 1.137-4.595 1.121-1.958-.018-3.456-2.005-4.575-3.775C-2.85 14.97-3.18 9.31-1.058 6.342c1.504-2.105 3.876-3.336 6.105-3.336 2.27 0 3.696 1.247 5.572 1.247 1.819 0 2.926-1.249 5.548-1.249 1.987 0 4.094 1.085 5.594 2.96-4.916 2.69-4.117 9.717-1.262 11.086z" />
          </svg>
          {t("continuaCuApple")}
        </a>)}
      </div>
      <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-widest text-white/40">
        <span className="h-px flex-1 bg-white/10" />
        {t("sau")}
        <span className="h-px flex-1 bg-white/10" />
      </div>
    </div>
  );
}

