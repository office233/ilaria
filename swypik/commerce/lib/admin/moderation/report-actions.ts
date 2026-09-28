/**
 * Decizii pe rapoartele de moderare (moderation_reports) — o singură
 * implementare pentru cele 4 rute /api/admin/moderation/[id]/*.
 *
 *   dismiss      — raportul nu se confirmă (caz „dismissed / no_action”)
 *   hide_video   — clipul e ascuns; toate rapoartele deschise pe el se închid
 *   delete_video — clipul e șters logic (status 'deleted'); rapoartele se închid
 *   ban_creator  — creatorul e suspendat MODERATION_BAN_DAYS zile
 *
 * Totul într-o tranzacție reală (withTransaction — înainte, BEGIN/COMMIT
 * mergeau pe conexiuni diferite din pool). Notificările (traduse) pleacă după
 * commit, best-effort.
 *
 * Doar rapoartele încă deschise (open / triaged) pot fi decise: raportul e
 * blocat (FOR UPDATE) și starea verificată sub lock — două click-uri / doi
 * moderatori nu mai produc cazuri, acțiuni sau suspendări duble (→ 409).
 */
import { withTransaction, type TxQuery } from "@/lib/db";
import { notifyLocalized } from "@/lib/notifications/localized";
import { revokeAdminSessionsForUser } from "@/lib/security/admin-auth";

export const REPORT_ACTIONS = ["dismiss", "hide_video", "delete_video", "ban_creator"] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

/** Durata suspendării la „ban creator” (zile). Configurabil prin env. */
export function moderationBanDays(): number {
  const n = Number(process.env.MODERATION_BAN_DAYS);
  return Number.isInteger(n) && n > 0 && n <= 3650 ? n : 7;
}

/** Stările în care un raport mai poate fi decis. */
const OPEN_REPORT_STATUSES: readonly string[] = ["open", "triaged"];

type ReportRow = {
  id: string;
  status: string;
  reason: string;
  target_video_id: string | null;
  target_user_id: string | null;
  target_comment_id: string | null;
  creator_id: string | null;
};

export type ReportActionResult =
  | { ok: true; report: ReportRow; notified: string | null }
  | { ok: false; status: 404; error: "report_not_found" | "report_invalid_no_video" | "creator_not_found" }
  | { ok: false; status: 400; error: "cannot_suspend_admin" }
  | { ok: false; status: 409; error: "report_already_decided" };

/** Ținta unui caz (exact una, cf. moderation_cases_check). */
function caseTarget(r: ReportRow, targetUser: boolean): [string | null, string | null, string | null] {
  if (targetUser) return [null, r.creator_id, null];
  if (r.target_video_id) return [r.target_video_id, null, null];
  if (r.target_user_id) return [null, r.target_user_id, null];
  return [null, null, r.target_comment_id];
}

const CLOSE_VIDEO_REPORTS = `UPDATE moderation_reports SET status = 'actioned', updated_at = now()
  WHERE target_video_id = $1 AND status IN ('open', 'triaged')`;

async function openCase(
  q: TxQuery,
  r: ReportRow,
  c: { severity: string; status: string; decision: string; note: string | null; actorUserId: string | null; targetUser?: boolean },
): Promise<string> {
  const { rows } = await q<{ id: string }>(
    `INSERT INTO moderation_cases (opened_by_report_id, target_video_id, target_user_id, target_comment_id, severity,
                                   status, decision, resolution_note, resolved_by_user_id, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now()) RETURNING id`,
    [
      r.id,
      ...caseTarget(r, Boolean(c.targetUser)),
      c.severity,
      c.status,
      c.decision,
      c.note,
      c.actorUserId,
    ],
  );
  return rows[0].id;
}

export async function applyReportAction(args: {
  reportId: string;
  action: ReportAction;
  note: string | null;
  actorUserId: string | null;
}): Promise<ReportActionResult> {
  const { reportId, action, note, actorUserId } = args;

  const result = await withTransaction<ReportActionResult>(async (q) => {
    const { rows } = await q<ReportRow>(
      `SELECT mr.id::text, mr.status, mr.reason, mr.target_video_id::text, mr.target_user_id::text,
              mr.target_comment_id::text, v.creator_id::text
         FROM moderation_reports mr
         LEFT JOIN videos v ON v.id = mr.target_video_id
        WHERE mr.id = $1 FOR UPDATE OF mr`,
      [reportId],
    );
    const r = rows[0];
    if (!r) return { ok: false, status: 404, error: "report_not_found" };
    if (!OPEN_REPORT_STATUSES.includes(r.status)) {
      return { ok: false, status: 409, error: "report_already_decided" };
    }

    if (action === "dismiss") {
      await q(
        `UPDATE moderation_reports SET status = 'dismissed', updated_at = now()
          WHERE id = $1 AND status IN ('open', 'triaged')`,
        [r.id],
      );
      const caseId = await openCase(q, r, { severity: "low", status: "dismissed", decision: "no_action", note, actorUserId });
      const [video, user, comment] = caseTarget(r, false);
      await q(
        `INSERT INTO moderation_actions (case_id, actor_user_id, target_video_id, target_user_id, target_comment_id,
                                        action_type, reason)
         VALUES ($1, $2, $3, $4, $5, 'restore', $6)`,
        [caseId, actorUserId, video, user, comment, note ?? r.reason],
      );
      return { ok: true, report: r, notified: null };
    }

    if (action === "ban_creator") {
      if (!r.creator_id) return { ok: false, status: 404, error: "creator_not_found" };
      const days = moderationBanDays();
      const suspended = await q(
        `UPDATE users SET suspended_until = now() + ($2::int * interval '1 day'), suspension_reason = $3, updated_at = now()
          WHERE id = $1 AND role <> 'admin'`,
        [r.creator_id, days, note ?? r.reason],
      );
      if (suspended.rowCount === 0) return { ok: false, status: 400, error: "cannot_suspend_admin" };
      await q(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [r.creator_id]);
      await revokeAdminSessionsForUser(r.creator_id, q);
      if (r.target_video_id) await q(CLOSE_VIDEO_REPORTS, [r.target_video_id]);
      const caseId = await openCase(q, r, {
        severity: "high", status: "resolved", decision: "suspend_user", note, actorUserId, targetUser: true,
      });
      await q(
        `INSERT INTO moderation_actions (case_id, actor_user_id, target_user_id, action_type, reason, ends_at)
         VALUES ($1, $2, $3, 'suspend_user', $4, now() + ($5::int * interval '1 day'))`,
        [caseId, actorUserId, r.creator_id, note ?? r.reason, days],
      );
      return { ok: true, report: r, notified: r.creator_id };
    }

    // hide_video / delete_video
    if (!r.target_video_id) return { ok: false, status: 404, error: "report_invalid_no_video" };
    const del = action === "delete_video";
    await q(
      del
        ? `UPDATE videos SET status = 'deleted', is_hidden = true, hidden_at = now(), archived_at = now(), updated_at = now() WHERE id = $1`
        : `UPDATE videos SET is_hidden = true, hidden_at = now(), updated_at = now() WHERE id = $1`,
      [r.target_video_id],
    );
    await q(CLOSE_VIDEO_REPORTS, [r.target_video_id]);
    const decision = del ? "delete" : "hide";
    const caseId = await openCase(q, r, { severity: del ? "high" : "medium", status: "resolved", decision, note, actorUserId });
    await q(
      `INSERT INTO moderation_actions (case_id, actor_user_id, target_video_id, action_type, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [caseId, actorUserId, r.target_video_id, decision, note ?? r.reason],
    );
    return { ok: true, report: r, notified: r.creator_id };
  });

  if (result.ok && result.notified) {
    const notice = action === "ban_creator" ? "accountSuspended" : action === "delete_video" ? "videoRemoved" : "videoHidden";
    await notifyLocalized(result.notified, notice, {
      url: "/account",
      values: { days: moderationBanDays() },
    });
  }
  return result;
}
