/**
 * Emailuri pentru flotă (Swypik Go / Food): decizia pe aplicația de șofer/
 * curier și pe franciza de flotă. Tranzacționale — nu depind de marketing.
 * Apelanți țintă: app/api/admin/fleet/[id], app/api/admin/fleet-partners/[id].
 */
import { localeForEmail } from "../i18n";
import { emailLink } from "../links";
import type { EmailBlock } from "../layout";
import { deliver, tr } from "./base";

export type FleetDecisionInput = {
  to: string;
  kind: "driver" | "courier";
  name: string;
  decision: "approve" | "reject";
  /** Treapta de comision la aprobare (Founding Drivers). */
  commission?: { promoDays: number; pct: number; founding: boolean } | null;
  referralCode?: string | null;
};

export async function sendFleetDecisionEmail(input: FleetDecisionInput): Promise<boolean> {
  const locale = await localeForEmail(input.to);
  const x = await tr(locale, "fleet");
  const role = x.t(input.kind === "driver" ? "roleDriver" : "roleCourier");
  if (input.decision === "reject") {
    return deliver({
      to: input.to,
      subject: x.t("rejectedSubject", { role }),
      title: x.t("rejectedTitle", { name: input.name }),
      tr: x,
      blocks: [{ type: "p", text: x.t("rejectedBody") }],
    });
  }
  const blocks: EmailBlock[] = [{ type: "p", text: x.t("approvedBody") }];
  if (input.commission) {
    blocks.push({ type: "p", text: x.t("commission", { days: input.commission.promoDays, pct: input.commission.pct }) });
    if (input.commission.founding) blocks.push({ type: "p", text: x.t("founding") });
  }
  if (input.referralCode) blocks.push({ type: "box", label: x.t("referralLabel"), text: input.referralCode });
  if (input.referralCode) blocks.push({ type: "small", text: x.t("referralHint") });
  blocks.push({ type: "button", label: x.t("cta"), href: emailLink(locale, "/courier") });
  return deliver({
    to: input.to,
    subject: x.t("approvedSubject", { role }),
    title: x.t("approvedTitle", { name: input.name }),
    tr: x,
    blocks,
  });
}

export async function sendFleetPartnerDecisionEmail(input: {
  to: string;
  company: string;
  decision: "approve" | "reject";
}): Promise<boolean> {
  const locale = await localeForEmail(input.to);
  const x = await tr(locale, "fleet");
  const approved = input.decision === "approve";
  return deliver({
    to: input.to,
    subject: x.t(approved ? "partnerApprovedSubject" : "partnerRejectedSubject", { company: input.company }),
    title: approved ? x.t("partnerApprovedTitle") : x.t("rejectedTitle", { name: input.company }),
    tr: x,
    blocks: approved
      ? [
          { type: "p", text: x.t("partnerApprovedBody") },
          { type: "button", label: x.t("cta"), href: emailLink(locale, "/fleet") },
        ]
      : [{ type: "p", text: x.t("partnerRejectedBody") }],
  });
}
