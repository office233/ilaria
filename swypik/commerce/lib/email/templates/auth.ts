/** Emailuri de cont: cod de autentificare, confirmare email, bun venit, resetare parolă, ștergere cont. */
import { SUPPORT_EMAIL } from "@/lib/contact";
import type { Locale } from "@/lib/i18n/config";
import { EMAIL_VERIFY_TTL_HOURS, OTP_TTL_MINUTES, PASSWORD_RESET_TTL_MINUTES } from "@/lib/auth/ttl";
import { emailLink } from "../links";
import { deliver, greeting, tr } from "./base";

/** Codul de autentificare (login fără parolă). NU e emailul de confirmare. */
export async function sendLoginCodeEmail(email: string, code: string, locale: Locale): Promise<boolean> {
  const x = await tr(locale, "loginCode");
  return deliver({
    to: email,
    subject: x.t("subject"),
    title: x.t("title"),
    preheader: x.t("intro"),
    tr: x,
    blocks: [
      { type: "p", text: x.t("intro") },
      { type: "code", text: code },
      { type: "small", text: x.t("expires", { minutes: OTP_TTL_MINUTES }) },
      { type: "small", text: x.tc("ignore") },
    ],
  });
}

/** Confirmarea adresei de email — link către /auth/verify-email. */
export async function sendVerifyEmail(email: string, token: string, locale: Locale): Promise<boolean> {
  const x = await tr(locale, "verify");
  const href = emailLink(locale, "/auth/verify-email", { token });
  return deliver({
    to: email,
    subject: x.t("subject"),
    title: x.t("title"),
    preheader: x.t("intro", { email }),
    tr: x,
    blocks: [
      { type: "p", text: x.t("intro", { email }) },
      { type: "button", label: x.t("cta"), href },
      { type: "small", text: x.t("expires", { hours: EMAIL_VERIFY_TTL_HOURS }) },
      { type: "small", text: x.tc("linkFallback") },
      { type: "link", href },
      { type: "small", text: x.tc("ignore") },
    ],
  });
}

/** Bun venit — o singură dată, după confirmarea emailului; salută prenumele. */
export async function sendWelcomeEmail(email: string, firstName: string | null | undefined, locale: Locale): Promise<boolean> {
  const x = await tr(locale, "welcome");
  const name = (firstName ?? "").trim();
  return deliver({
    to: email,
    subject: x.t("subject"),
    title: name ? x.t("title", { name }) : x.t("titleNoName"),
    tr: x,
    blocks: [
      { type: "p", text: x.t("intro") },
      {
        type: "buttons",
        items: [
          { label: x.t("ctaExplore"), href: emailLink(locale, "/explore") },
          { label: x.t("ctaAccount"), href: emailLink(locale, "/account") },
        ],
      },
    ],
  });
}

export async function sendPasswordResetEmail(
  email: string,
  token: string,
  firstName: string | null | undefined,
  locale: Locale,
): Promise<boolean> {
  const x = await tr(locale, "reset");
  const href = emailLink(locale, "/auth/reset", { token });
  return deliver({
    to: email,
    subject: x.t("subject"),
    title: x.t("title"),
    tr: x,
    blocks: [
      greeting(x.tc, firstName),
      { type: "p", text: x.t("intro") },
      { type: "button", label: x.t("cta"), href },
      { type: "small", text: x.t("expires", { minutes: PASSWORD_RESET_TTL_MINUTES }) },
      { type: "small", text: x.tc("linkFallback") },
      { type: "link", href },
      { type: "small", text: x.tc("ignore") },
    ],
  });
}

export async function sendAccountDeletedEmail(email: string, locale: Locale): Promise<boolean> {
  const x = await tr(locale, "accountDeleted");
  return deliver({
    to: email,
    subject: x.t("subject"),
    title: x.t("title"),
    tr: x,
    blocks: [
      { type: "p", text: x.t("body") },
      { type: "small", text: x.t("notYou", { email: SUPPORT_EMAIL }) },
    ],
  });
}
