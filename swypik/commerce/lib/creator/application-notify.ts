/**
 * Anunță decizia pe aplicarea de creator: notificare in-app + email, ambele
 * în limba utilizatorului (namespace `creatorApplicationEmail` /
 * `notificationsText`). Best-effort: eșecul nu anulează decizia.
 */
import { getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { sendEmail } from "@/lib/email/service";
import { APP_URL } from "@/lib/app-url";
import { SUPPORT_EMAIL } from "@/lib/contact";
import { logger } from "@/lib/logger";
import { routing } from "@/lib/i18n/routing";
import { notifyLocalized } from "@/lib/notifications/localized";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export async function notifyApplicationDecision(args: {
  userId: string;
  decision: "approved" | "rejected";
  reason?: string | null;
}): Promise<void> {
  const { userId, decision } = args;
  const reason = args.reason ?? "";
  await notifyLocalized(userId, decision === "approved" ? "creatorApproved" : "creatorRejected", {
    url: decision === "approved" ? "/creator" : "/become-a-creator",
    values: { reason },
  });

  try {
    const { rows } = await dbQuery<{ email: string | null; username: string | null; locale: string | null }>(
      `SELECT email, username, locale FROM users WHERE id = $1`,
      [userId],
    );
    const u = rows[0];
    if (!u?.email) return;
    const locale = (routing.locales as readonly string[]).includes(u.locale ?? "") ? (u.locale as string) : routing.defaultLocale;
    const t = await getTranslations({ locale, namespace: "creatorApplicationEmail" });
    const name = escapeHtml(u.username ?? "");
    const paragraphs =
      decision === "approved"
        ? [t("approvedBody"), `<a href="${APP_URL}/creator">${escapeHtml(t("approvedCta"))}</a>`]
        : [
            t("rejectedBody"),
            // Fără motiv → fără <blockquote> gol.
            ...(reason?.trim() ? [`<blockquote>${escapeHtml(reason.trim())}</blockquote>`] : []),
            t("rejectedRetry"),
          ];
    await sendEmail({
      to: u.email,
      subject: decision === "approved" ? t("approvedSubject") : t("rejectedSubject"),
      html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:24px">
        <h1 style="font-size:22px;margin:0 0 12px">${escapeHtml(t("greeting", { name }))}</h1>
        ${paragraphs.map((p) => (p.startsWith("<") ? p : `<p>${escapeHtml(p)}</p>`)).join("\n")}
        <p style="margin-top:24px;font-size:12px;opacity:.7">${escapeHtml(t("footer", { email: SUPPORT_EMAIL }))}</p>
      </div>`,
    });
  } catch (err) {
    logger.warn({ err, userId, decision }, "creator.application.email_failed");
  }
}
