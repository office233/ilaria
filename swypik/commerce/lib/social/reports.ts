/**
 * Rapoarte de moderare pe utilizatori și comentarii (reutilizează
 * `moderation_reports`, aceeași coadă ca rapoartele pe video). Doar conturi
 * reale pot raporta (valul de securitate: fără rapoarte anonime în masă).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";
import { getAccountUserId } from "@/lib/social/session";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { REPORT_REASONS, SOCIAL_LIMITS } from "./config";

export type ReportTarget = "user" | "comment";

export const ReportBodySchema = z.object({
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(500).optional().nullable(),
});

const TARGET_SQL: Record<ReportTarget, { exists: string; column: string }> = {
  user: { exists: `SELECT id FROM users WHERE id = $1`, column: "target_user_id" },
  comment: { exists: `SELECT id FROM comments WHERE id = $1 AND status <> 'deleted'`, column: "target_comment_id" },
};

/** Inserează raportul; `false` dacă reporterul are deja un raport deschis pe aceeași țintă. */
export async function createReport(
  reporterId: string,
  target: ReportTarget,
  targetId: string,
  reason: string,
  details: string | null,
): Promise<boolean> {
  const { column } = TARGET_SQL[target];
  const { rows } = await dbQuery(
    `INSERT INTO moderation_reports (reporter_user_id, ${column}, reason, note, metadata)
     SELECT $1, $2, $3, $4, $5::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM moderation_reports
         WHERE reporter_user_id = $1 AND ${column} = $2 AND status = 'open'
      )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [reporterId, targetId, reason, details, JSON.stringify({ source: `${target}_report` })],
  );
  return rows.length > 0;
}

export async function handleReport(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  target: ReportTarget,
) {
  try {
    const { id } = await params;
    if (!isUuidParam(id)) return invalidIdResponse();
    const reporterId = await getAccountUserId();
    if (!reporterId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (target === "user" && reporterId === id) {
      return NextResponse.json({ error: "cannot_report_self" }, { status: 400 });
    }

    const rl = await rateLimit("social_report", reporterId, SOCIAL_LIMITS.reportPerUser);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = ReportBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid_reason" }, { status: 400 });

    const { rows } = await dbQuery(TARGET_SQL[target].exists, [id]);
    if (rows.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const created = await createReport(reporterId, target, id, parsed.data.reason, parsed.data.details ?? null);
    return NextResponse.json({ ok: true, duplicate: !created });
  } catch (error) {
    logger.error({ err: error, target }, "[report] failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
