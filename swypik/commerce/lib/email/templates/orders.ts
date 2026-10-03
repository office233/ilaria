/** Emailuri tranzacționale pentru cumpărători: confirmare, expediere, rambursare + coș abandonat (marketing). */
import { hasMarketingConsent } from "../consent";
import { localeForEmail } from "../i18n";
import { emailLink } from "../links";
import { deliver, greeting, money, shortOrderNumber, tr } from "./base";
import { orderContextById, orderContextByTracking, orderLink } from "./order-context";

export interface OrderEmailData {
  orderId: string;
  orderLookupToken?: string;
  customerEmail: string;
  customerName: string;
  items: { title: string; quantity: number; price: number }[];
  /** Totalul în unități întregi ale monedei (istoric „Ron"). */
  totalRon: number;
  currency?: string;
  shippingAddress?: { name?: string; line1?: string; city?: string; postal_code?: string; country?: string };
  trackingNumber?: string;
  trackingUrl?: string;
}

const cents = (units: number) => Math.round(Number(units || 0) * 100);

export async function sendOrderConfirmation(data: OrderEmailData): Promise<boolean> {
  const ctx = await orderContextById(data.orderId, data.customerEmail);
  if (data.orderLookupToken) ctx.lookupToken = data.orderLookupToken;
  const x = await tr(ctx.locale, "order");
  const cur = data.currency || "RON";
  const number = shortOrderNumber(data.orderId);
  const a = data.shippingAddress;
  const address = a ? [a.name, a.line1, [a.city, a.postal_code].filter(Boolean).join(", ")].filter(Boolean).join(", ") : "";
  return deliver({
    to: data.customerEmail,
    subject: x.t("confirmedSubject", { number }),
    title: x.t("confirmedTitle"),
    tr: x,
    blocks: [
      greeting(x.tc, data.customerName),
      { type: "p", text: x.t("confirmedIntro") },
      { type: "small", text: x.tc("orderNumber", { number }) },
      {
        type: "table",
        head: [x.tc("colProduct"), x.tc("colQty"), x.tc("colPrice")],
        rows: data.items.map((i) => [i.title, String(i.quantity), money(ctx.locale, cents(i.price) * i.quantity, cur)]),
        foot: [x.tc("total"), money(ctx.locale, cents(data.totalRon), cur)],
      },
      ...(address ? [{ type: "box" as const, label: x.t("shippingAddress"), text: address }] : []),
      { type: "button", label: x.t("track"), href: orderLink(ctx) },
    ],
  });
}

/** AWB introdus de seller → cumpărătorul. `orderId` opțional (altfel se caută după AWB). */
export async function sendCustomerShippingAlert(
  email: string,
  trackingNumber: string,
  opts: { orderId?: string; trackingUrl?: string | null } = {},
): Promise<boolean> {
  const ctx = opts.orderId ? await orderContextById(opts.orderId, email) : await orderContextByTracking(trackingNumber, email);
  const x = await tr(ctx.locale, "order");
  const number = ctx.orderId ? shortOrderNumber(ctx.orderId) : "";
  const trackingUrl = opts.trackingUrl && /^https:\/\//i.test(opts.trackingUrl) ? opts.trackingUrl : null;
  return deliver({
    to: email,
    subject: number ? x.t("shippedSubject", { number }) : x.t("shippedTitle"),
    title: x.t("shippedTitle"),
    tr: x,
    blocks: [
      { type: "p", text: x.t("shippedIntro") },
      { type: "box", label: x.t("awb"), text: trackingNumber },
      ...(trackingUrl ? [{ type: "button" as const, label: x.t("trackCarrier"), href: trackingUrl }] : []),
      { type: "button", label: x.t("view"), href: orderLink(ctx) },
    ],
  });
}

export async function sendRefundEmail(toEmail: string, orderId: string, amountCents: number, currency: string): Promise<boolean> {
  const ctx = await orderContextById(orderId, toEmail);
  const x = await tr(ctx.locale, "order");
  const number = shortOrderNumber(orderId);
  return deliver({
    to: toEmail,
    subject: x.t("refundSubject", { number }),
    title: x.t("refundTitle"),
    tr: x,
    blocks: [
      { type: "small", text: x.tc("orderNumber", { number }) },
      { type: "p", text: x.t("refundBody", { amount: money(ctx.locale, amountCents, currency) }) },
      { type: "button", label: x.t("view"), href: orderLink(ctx) },
    ],
  });
}

export interface AbandonedCartItem {
  title: string;
  price: number;
  image?: string;
  quantity?: number;
}

/**
 * Coș abandonat — MARKETING: pleacă doar cu FEATURE_EMAIL_MARKETING și
 * consimțământ (verificate de cron), are footer de dezabonare.
 */
export async function sendAbandonedCartEmail(
  email: string,
  cartItems: AbandonedCartItem[],
  checkoutUrl: string,
  currency = "RON",
): Promise<boolean> {
  if (!(await hasMarketingConsent(email))) return false;
  const locale = await localeForEmail(email);
  const ctx = { locale };
  const x = await tr(locale, "cart");
  const total = cartItems.reduce((s, i) => s + cents(i.price) * Math.max(1, Number(i.quantity || 1)), 0);
  const href = /^https:\/\//i.test(checkoutUrl) ? checkoutUrl : emailLink(ctx.locale, "/cart");
  return deliver({
    to: email,
    subject: x.t("subject"),
    title: x.t("title"),
    marketing: true,
    tr: x,
    blocks: [
      { type: "p", text: x.t("intro") },
      {
        type: "cards",
        items: cartItems.map((i) => ({
          title: Number(i.quantity || 1) > 1 ? `${i.title} × ${i.quantity}` : i.title,
          href,
          image: i.image && /^https:\/\//i.test(i.image) ? i.image : null,
          meta: money(ctx.locale, cents(i.price) * Math.max(1, Number(i.quantity || 1)), currency),
        })),
      },
      { type: "box", label: x.tc("total"), text: money(ctx.locale, total, currency) },
      { type: "button", label: x.t("cta"), href },
      { type: "small", text: x.t("note") },
    ],
  });
}
