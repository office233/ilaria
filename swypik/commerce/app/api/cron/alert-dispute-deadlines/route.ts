/**
 * Daily cron: alert admin via email about Stripe disputes whose evidence
 * deadline is approaching (<72h) and no evidence has been submitted yet.
 *
 * Schedule (crontab): once per day, e.g. `0 9 * * *`.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { dbQuery } from "@/lib/db";
import { sendEmail } from "@/lib/email/service";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { logger } from "@/lib/logger";
import { APP_URL } from "@/lib/app-url";

export const dynamic = "force-dynamic";

const ALERT_TO = process.env.DISPUTE_ALERT_EMAIL || process.env.ADMIN_ALERT_EMAIL || "";
const COOLDOWN_HOURS = Number(process.env.DISPUTE_ALERT_COOLDOWN_HOURS ?? 12);

function authorize(req: Request): boolean {
  const header =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    req.headers.get("x-cron-secret") ||
    req.headers.get("cron-secret") ||
    "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !header) return false;
  if (Buffer.byteLength(header) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

type Row = {
  dispute_id: string;
  amount_cents: number;
  currency: string;
  reason: string | null;
  status: string;
  evidence_due_by: string;
  order_id: string | null;
  hours_left: number;
  buyer_email: string | null;
};

async function handle(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ALERT_TO) {
    return NextResponse.json({ success: true, skipped: true, reason: "no_alert_email_configured" });
  }

  const res = await runCron("alert-dispute-deadlines", async () => {
    const { rows } = await dbQuery<Row>(
      `SELECT d.dispute_id,
              d.amount_cents,
              d.currency,
              d.reason,
              d.status,
              d.evidence_due_by::text                                          AS evidence_due_by,
              d.order_id::text                                                 AS order_id,
              EXTRACT(EPOCH FROM (d.evidence_due_by - now())) / 3600           AS hours_left,
              u.email                                                          AS buyer_email
         FROM stripe_disputes d
         LEFT JOIN commerce_orders co ON co.id = d.order_id
         LEFT JOIN users u ON u.id = co.buyer_user_id
        WHERE d.status IN ('needs_response','warning_needs_response')
          AND d.evidence_submitted = false
          AND d.evidence_due_by IS NOT NULL
          AND d.evidence_due_by < now() + interval '72 hours'
          AND (
                (d.metadata->>'last_alert_at') IS NULL
             OR (d.metadata->>'last_alert_at')::timestamptz < now() - ($1 || ' hours')::interval
          )
        ORDER BY d.evidence_due_by ASC
        LIMIT 50`,
      [String(COOLDOWN_HOURS)],
    );

    if (rows.length === 0) {
      return NextResponse.json({ success: true, alerted: 0 });
    }

    const totalAtRiskCents = rows.reduce((s, r) => s + r.amount_cents, 0);
    const fmtMoney = (c: number, cur = "RON") => {
      try {
        return new Intl.NumberFormat("ro-RO", { style: "currency", currency: cur.toUpperCase() }).format(c / 100);
      } catch {
        return `${(c / 100).toFixed(2)} ${cur.toUpperCase()}`;
      }
    };

    const subject = `[Swypik] ${rows.length} dispute(uri) cu deadline <72h — total ${fmtMoney(totalAtRiskCents)}`;

    const rowsHtml = rows
      .map((r) => {
        const hrs = Math.round(r.hours_left);
        const urgent = hrs < 24 ? "color:#b91c1c;font-weight:bold;" : "color:#c2410c;font-weight:bold;";
        return `
          <tr>
            <td style="padding:6px;border:1px solid #ddd;font-family:monospace">${r.dispute_id}</td>
            <td style="padding:6px;border:1px solid #ddd">${fmtMoney(r.amount_cents, r.currency)}</td>
            <td style="padding:6px;border:1px solid #ddd">${r.reason || "—"}</td>
            <td style="padding:6px;border:1px solid #ddd">${r.buyer_email || "—"}</td>
            <td style="padding:6px;border:1px solid #ddd;${urgent}">${hrs}h</td>
            <td style="padding:6px;border:1px solid #ddd">${new Date(r.evidence_due_by).toLocaleString("ro-RO")}</td>
          </tr>`;
      })
      .join("");

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:760px">
        <h2 style="color:#0D0D0D">Stripe Disputes — deadline aproape</h2>
        <p>${rows.length} dispute(uri) cu evidence nesubmis și deadline în &lt;72h.<br>
        <strong>Total expunere: ${fmtMoney(totalAtRiskCents)}</strong></p>
        <table style="border-collapse:collapse;width:100%;font-size:13px">
          <thead>
            <tr style="background:#f3f4f6">
              <th style="padding:6px;border:1px solid #ddd;text-align:left">Dispute</th>
              <th style="padding:6px;border:1px solid #ddd;text-align:left">Sumă</th>
              <th style="padding:6px;border:1px solid #ddd;text-align:left">Motiv</th>
              <th style="padding:6px;border:1px solid #ddd;text-align:left">Buyer</th>
              <th style="padding:6px;border:1px solid #ddd;text-align:left">Timp</th>
              <th style="padding:6px;border:1px solid #ddd;text-align:left">Deadline</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <p style="margin-top:16px">
          <a href="${APP_URL}/admin/disputes?status=needs_response"
             style="background:#0D0D0D;color:#fff;padding:10px 16px;text-decoration:none;border-radius:8px;display:inline-block">
            Răspunde acum
          </a>
        </p>
        <p style="color:#666;font-size:12px;margin-top:24px">
          Email automat trimis de cron-ul <code>alert-dispute-deadlines</code>.
          Cooldown: ${COOLDOWN_HOURS}h per dispute (nu re-spamă).
        </p>
      </div>`;

    const sent = await sendEmail({ to: ALERT_TO, subject, html });

    if (sent) {
      const ids = rows.map((r) => r.dispute_id);
      await dbQuery(
        `UPDATE stripe_disputes
            SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('last_alert_at', now()::text)
          WHERE dispute_id = ANY($1::text[])`,
        [ids],
      );
      logger.info({ count: rows.length, totalAtRiskCents, to: ALERT_TO }, "[Cron] Dispute deadline alert sent");
    } else {
      logger.error({ count: rows.length }, "[Cron] sendEmail returned false for dispute alert");
    }

    return NextResponse.json({ success: true, alerted: rows.length, totalAtRiskCents, sent });
  });
  return res ?? cronSkippedResponse("alert-dispute-deadlines");
}

export const GET = handle;
export const POST = handle;
