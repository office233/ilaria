"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowRight, Mail, KeyRound, Loader2, ArrowLeft, AlertCircle } from "lucide-react";
import { errorMessage } from "@/lib/error-message";

/** Codurile de eroare ale /api/seller/auth → chei de traducere. */
const LOGIN_ERROR_KEYS: Record<string, string> = {
  rate_limited: "errorRateLimited",
  rate_limited_email: "errorRateLimited",
  too_many_attempts: "errorRateLimited",
  otp_locked: "errorOtpLocked",
  missing_fields: "errorMissingFields",
  invalid_code: "errorInvalidOtp",
};

/** Only allow same-site relative paths for the post-login redirect (avoid open redirect). */
function safeNextPath(next: string | null): string {
  if (!next) return "/seller";
  // Only same-site paths: reject protocol-relative ("//x"), backslash tricks
  // ("/\x" is normalized to "//x" by browsers) and anything with a scheme.
  if (!next.startsWith("/") || next.includes("\\") || next.startsWith("//") || /^\/[a-z][\w+.-]*:/i.test(next)) {
    return "/seller";
  }
  return next;
}

export default function SellerLogin() {
  return (
    <Suspense fallback={null}>
      <SellerLoginForm />
    </Suspense>
  );
}

function SellerLoginForm() {
  const t = useTranslations("sellerGrowthLogin");

  const router = useRouter();
  const searchParams = useSearchParams();
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch("/api/seller/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", email }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(t(LOGIN_ERROR_KEYS[data?.error as string] ?? "errorGeneric"));
      }

      // API răspunde generic (anti-enumeration) cu {success:true, message}
      // Trecem mereu la step 2 dacă requestul a fost OK.
      if (data.success || data.requiresVerification) {
        setStep(2);
      } else {
        setError(t(LOGIN_ERROR_KEYS[data?.error as string] ?? "errorSendCode"));
      }
    } catch (err) {
      setError(errorMessage(err) || t("errorGeneric"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch("/api/seller/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify_otp", email, token: otpCode }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(t(LOGIN_ERROR_KEYS[data?.error as string] ?? "errorInvalidOtp"));
      }

      // Success — redirect to the originally requested page, or the dashboard.
      router.push(safeNextPath(searchParams.get("next")));
    } catch (err) {
      setError(errorMessage(err) || t("errorInvalidOtp"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8 font-sans">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <Link href="/" className="flex justify-center items-center gap-2 transition-transform hover:scale-105 active:scale-95">
          <div className="w-10 h-10 bg-black rounded-xl flex items-center justify-center shadow-lg">
            <span className="text-white font-bold text-xl tracking-tighter">S</span>
          </div>
          <span className="text-2xl font-black tracking-tight text-gray-900">swypik</span>
        </Link>
        <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900 tracking-tight">
          {step === 1 ? t("portalTitle") : t("verificationTitle")}
        </h2>
        <p className="mt-2 text-center text-sm text-gray-600">
          {step === 1
            ? t("emailStepHint")
            : t("otpStepHint")}
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow-xl shadow-gray-200/50 sm:rounded-2xl sm:px-10 border border-gray-100">
          
          {error && (
            <div className="mb-6 bg-red-50 border-l-4 border-red-500 p-4 rounded-xl flex items-start animate-in fade-in slide-in-from-top-2">
              <div className="flex-shrink-0">
                <AlertCircle className="h-5 w-5 text-red-500" />
              </div>
              <div className="ml-3">
                <p className="text-sm text-red-700 font-medium">
                  {error}
                </p>
              </div>
            </div>
          )}

          {step === 1 ? (
            <form className="space-y-6 animate-in fade-in zoom-in-95 duration-300" onSubmit={handleEmailSubmit}>
              <div>
                <label htmlFor="email" className="block text-sm font-semibold text-gray-700 mb-1">
                  {t("emailLabel")}
                </label>
                <div className="relative rounded-xl shadow-sm">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Mail className="h-5 w-5 text-gray-400" />
                  </div>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black focus:border-black sm:text-sm transition-all bg-gray-50 focus:bg-white"
                    placeholder="nume@magazin.ro"
                  />
                </div>
              </div>

              <div>
                <button
                  type="submit"
                  disabled={isLoading || !email}
                  className="w-full flex justify-center items-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-black hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-black disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-[0.98]"
                >
                  {isLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin" aria-label={t("loading")} />
                  ) : (
                    <>
                      {t("continueBtn")} <ArrowRight className="ml-2 w-5 h-5" />
                    </>
                  )}
                </button>
              </div>
            </form>
          ) : (
            <form className="space-y-6 animate-in fade-in zoom-in-95 duration-300" onSubmit={handleOtpSubmit}>
              <div>
                <label htmlFor="otp" className="block text-sm font-semibold text-gray-700 mb-1">
                  {t("otpLabel")}
                </label>
                <div className="relative rounded-xl shadow-sm">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <KeyRound className="h-5 w-5 text-gray-400" />
                  </div>
                  <input
                    id="otp"
                    name="otp"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    required
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                    className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black focus:border-black text-center text-xl font-mono tracking-[0.5em] transition-all bg-gray-50 focus:bg-white"
                    placeholder="000000"
                  />
                </div>
              </div>

              <div>
                <button
                  type="submit"
                  disabled={isLoading || otpCode.length !== 6}
                  className="w-full flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-black hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-black disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-[0.98]"
                >
                  {isLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin" aria-label={t("loading")} />
                  ) : (
                    t("signIn")
                  )}
                </button>
              </div>

              <div className="text-center mt-6">
                <button
                  type="button"
                  onClick={() => {
                    setStep(1);
                    setOtpCode("");
                    setError(null);
                  }}
                  className="text-sm font-medium text-gray-500 hover:text-black flex items-center justify-center w-full transition-colors"
                >
                  <ArrowLeft className="mr-1 w-4 h-4" /> {t("changeEmail")}
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="mt-8 text-center text-xs text-gray-500">
          {t("copyright", { year: new Date().getFullYear() })}
        </div>
      </div>
    </div>
  );
}
