/**
 * Swypik Email Service — fațada publică (importurile existente
 * `@/lib/email/service` rămân valide).
 *
 * Structură:
 *   config.ts      expeditor, reply-to, detectarea cheilor placeholder
 *   transport.ts   Resend / SMTP / none
 *   send.ts        trimiterea (fără provider → false, marketing → dezabonare)
 *   layout.ts      layout-ul de brand + partea text/plain
 *   i18n.ts        traduceri (`messages/*.json`, namespace `email`) + limba destinatarului
 *   links.ts       linkuri absolute localizate
 *   templates/*    câte un fișier pe domeniu (auth, orders, seller, fleet, ops, digest, notice)
 *
 * Tranzacționalele (cont, comenzi, rambursări, vânzători, creatori, flotă,
 * stays) NU depind de FEATURE_EMAIL_MARKETING. Marketingul (digest, coș
 * abandonat) cere flag-ul + consimțământul utilizatorului (consent.ts).
 */
import type { Locale } from "@/lib/i18n/config";
import { localeForEmail, normalizeLocale } from "./i18n";
import { sendLoginCodeEmail, sendWelcomeEmail as sendWelcome } from "./templates/auth";

export { sendEmail, emailReady } from "./send";
export { unsubscribeToken, unsubscribeUrl } from "./unsubscribe";
export {
  sendOrderConfirmation,
  sendCustomerShippingAlert,
  sendRefundEmail,
  sendAbandonedCartEmail,
  type OrderEmailData,
  type AbandonedCartItem,
} from "./templates/orders";
export { sendSellerNewOrderAlert, sendSellerApprovalEmail } from "./templates/seller";
export { sendVerifyEmail, sendPasswordResetEmail, sendAccountDeletedEmail } from "./templates/auth";
export { sendFleetDecisionEmail, sendFleetPartnerDecisionEmail } from "./templates/fleet";
export { sendOpsApplicationAlert } from "./templates/ops";
export { sendNoticeEmail } from "./templates/notice";

async function resolveLocale(email: string, locale?: Locale | string | null): Promise<Locale> {
  return locale ? normalizeLocale(locale) : localeForEmail(email);
}

/** Codul de autentificare (login fără parolă). Numele e istoric: NU conține link. */
export async function sendMagicLink(email: string, code: string, locale?: Locale | string | null): Promise<boolean> {
  return sendLoginCodeEmail(email, code, await resolveLocale(email, locale));
}

/** Bun venit (după confirmarea emailului); `firstName` = prenumele, nu username-ul. */
export async function sendWelcomeEmail(email: string, firstName: string | null, locale?: Locale | string | null): Promise<boolean> {
  return sendWelcome(email, firstName, await resolveLocale(email, locale));
}
