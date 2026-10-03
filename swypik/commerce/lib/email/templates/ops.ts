/**
 * Alertă internă către echipa de operațiuni (OPS_ALERT_EMAIL / SUPPORT_EMAIL):
 * aplicații noi de vânzător, gazdă, curier/șofer, franciză. Toate valorile
 * sunt escapate de layout (numele/telefonul vin de la utilizatori).
 */
import { DEFAULT_LOCALE } from "@/lib/i18n/config";
import { emailLink } from "../links";
import { deliver, tr } from "./base";

export type OpsApplicationKind = "seller" | "host" | "courier" | "driver" | "fleetPartner";
export type OpsField =
  | "company"
  | "cui"
  | "name"
  | "email"
  | "phone"
  | "city"
  | "vehicle"
  | "products"
  | "property"
  | "location"
  | "legalForm"
  | "vertical";

export function opsAlertRecipient(): string | null {
  return process.env.OPS_ALERT_EMAIL || process.env.SUPPORT_EMAIL || null;
}

export async function sendOpsApplicationAlert(input: {
  kind: OpsApplicationKind;
  /** Nume scurt pentru subiect (firmă, proprietate, persoană). */
  label: string;
  fields: Partial<Record<OpsField, string | null | undefined>>;
  /** Pagina de admin unde se verifică aplicația (ex. `/admin/fleet`). */
  adminPath: string;
}): Promise<boolean> {
  const to = opsAlertRecipient();
  if (!to) return false;
  const x = await tr(DEFAULT_LOCALE, "ops");
  const kind = x.t(`kind.${input.kind}`);
  const rows = (Object.entries(input.fields) as [OpsField, string | null | undefined][])
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => [x.t(`field.${k}`), String(v)] as [string, string]);
  return deliver({
    to,
    subject: x.t("subject", { kind, label: input.label }),
    title: x.t("title", { kind }),
    tr: x,
    blocks: [
      { type: "rows", items: rows },
      { type: "button", label: x.t("open"), href: emailLink(DEFAULT_LOCALE, input.adminPath) },
    ],
  });
}
