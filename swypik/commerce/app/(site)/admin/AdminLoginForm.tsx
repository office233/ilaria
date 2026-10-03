"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { TextField } from "@/components/ui/Input";

const ADMIN_LOGIN_URL = "/auth/login?next=/admin";

const ERROR_KEYS: Record<string, string> = {
  invalid_credentials: "errInvalidCredentials",
  too_many_attempts: "errTooManyAttempts",
  break_glass_disabled: "errBreakGlassDisabled",
  invalid_body: "errInvalidCredentials",
};

/**
 * Poarta consolei: adminii intră cu contul lor Swypik (cod pe email).
 * Formularul cu ADMIN_SECRET apare doar când accesul de urgență e activat.
 */
export default function AdminLoginForm({ breakGlass }: { breakGlass: boolean }) {
  const t = useTranslations("adminLogin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  // Sesiunea de admin se emite doar la un login proaspăt (cod OTP): închidem
  // întâi sesiunea curentă de cumpărător, apoi mergem la login cu întoarcere în /admin.
  async function signInWithAccount() {
    setRedirecting(true);
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    }).catch(() => undefined);
    window.location.href = ADMIN_LOGIN_URL;
  }

  async function handleBreakGlass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !payload.success) {
        setError(t(ERROR_KEYS[payload.error ?? ""] ?? "authFailed"));
        return;
      }
      window.location.reload();
    } catch {
      setError(t("unreachable"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-gutter pb-safe-b pt-safe-t">
      <Card className="w-full max-w-md space-y-6" padding="lg">
        <div className="space-y-2">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
            <ShieldCheck className="h-6 w-6" aria-hidden />
          </span>
          <h1 className="text-2xl font-bold text-fg">{t("title")}</h1>
          <p className="text-sm text-muted">{t("accountSignInBody")}</p>
        </div>

        <Button block size="lg" loading={redirecting} onClick={signInWithAccount}>
          {t("accountSignInCta")}
        </Button>

        {breakGlass ? (
          <form onSubmit={handleBreakGlass} className="space-y-4 border-t border-subtle pt-6">
            <div>
              <p className="text-sm font-semibold text-fg">{t("breakGlassTitle")}</p>
              <p className="text-sm text-muted">{t("breakGlassBody")}</p>
            </div>
            <TextField
              label={t("emailLabel")}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <TextField
              label={t("passwordLabel")}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error ? (
              <p role="alert" className="text-sm font-medium text-danger">{error}</p>
            ) : null}
            <Button type="submit" variant="secondary" block loading={loading} disabled={!email.trim() || !password}>
              {loading ? t("signingIn") : t("enterAdmin")}
            </Button>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
