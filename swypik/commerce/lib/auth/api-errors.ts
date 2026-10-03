/**
 * Erori ale API-ului de autentificare: cod stabil (`code`) + mesaj tradus
 * (`error`) în limba cererii (cookie `swypik_locale` / Referer / Accept-Language),
 * din `messages/*.json` → `authEmail.errors`. Clienții pot afișa direct
 * `error` sau pot traduce singuri după `code`.
 */
import { NextResponse } from "next/server";
import { localeFromRequest, translator } from "@/lib/email/i18n";

export type AuthErrorCode =
  | "invalidEmail"
  | "rateLimited"
  | "tooManyCodes"
  | "emailUnavailable"
  | "sendFailed"
  | "codeRequired"
  | "codeInvalid"
  | "passwordTooShort"
  | "passwordWeak"
  | "firstNameRequired"
  | "lastNameRequired"
  | "usernameInvalid"
  | "usernameReserved"
  | "usernameTaken"
  | "phoneInvalid"
  | "phoneTaken"
  | "emailTaken"
  | "credentialsInvalid"
  | "accountSuspended"
  | "temporaryError"
  | "twoFactorExpired"
  | "twoFactorInactive"
  | "twoFactorInvalid"
  | "invalidRequest"
  | "notLoggedIn"
  | "tokenInvalid"
  | "resetFailed"
  | "passwordRequiredFor2fa"
  | "alreadyVerified"
  | "unknownAction";

export async function authMessage(req: Request, code: AuthErrorCode, values?: Record<string, string | number>): Promise<string> {
  const t = await translator(localeFromRequest(req), "authEmail.errors");
  return t(code, values);
}

export async function authFail(
  req: Request,
  code: AuthErrorCode,
  status: number,
  extra: Record<string, unknown> = {},
): Promise<NextResponse> {
  return NextResponse.json({ success: false, code, error: await authMessage(req, code), ...extra }, { status });
}
