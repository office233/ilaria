/** Emailuri tranzacționale pentru vânzători (NU depind de FEATURE_EMAIL_MARKETING). */
import { localeForEmail } from "../i18n";
import { emailLink } from "../links";
import { deliver, tr } from "./base";

type SellerOrderItem = { title?: string | null; name?: string | null; quantity?: number | null };

export async function sendSellerNewOrderAlert(
  sellerEmail: string,
  orderItems: SellerOrderItem[],
  customerName = "",
): Promise<boolean> {
  const locale = await localeForEmail(sellerEmail);
  const x = await tr(locale, "seller");
  const customer = customerName && customerName !== "X" ? customerName : x.t("customerFallback");
  return deliver({
    to: sellerEmail,
    subject: x.t("newOrderSubject"),
    title: x.t("newOrderTitle"),
    tr: x,
    blocks: [
      { type: "p", text: x.t("newOrderIntro", { customer }) },
      {
        type: "table",
        head: [x.tc("colProduct"), x.tc("colQty")],
        rows: orderItems.map((i) => [String(i.title || i.name || "—"), String(Math.max(1, Number(i.quantity || 1)))]),
      },
      { type: "button", label: x.t("newOrderCta"), href: emailLink(locale, "/seller/orders") },
    ],
  });
}

export async function sendSellerApprovalEmail(email: string, name: string): Promise<boolean> {
  const locale = await localeForEmail(email);
  const x = await tr(locale, "seller");
  return deliver({
    to: email,
    subject: x.t("approvedSubject"),
    title: x.t("approvedTitle", { name: (name || "").trim() || email.split("@")[0] }),
    tr: x,
    blocks: [
      { type: "p", text: x.t("approvedBody") },
      { type: "button", label: x.t("approvedCta"), href: emailLink(locale, "/seller") },
    ],
  });
}
