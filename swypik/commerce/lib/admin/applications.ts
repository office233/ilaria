/**
 * Decizia pe o cerere de creator (creator_applications) din consola de admin.
 *
 * Doar cererile „în așteptare” (submitted / in_review) pot fi decise. Rândul e
 * blocat (FOR UPDATE) și UPDATE-ul e condiționat de starea curentă, într-o
 * singură tranzacție: două click-uri / doi admini nu mai produc o dublă
 * promovare, o dublă acțiune de moderare sau aprobare-peste-respingere (→ 409).
 */
import { withTransaction } from "@/lib/db";

export const PENDING_APPLICATION_STATUSES = ["submitted", "in_review"] as const;
const PENDING_SQL = `status IN ('submitted', 'in_review')`;

export type ApplicationDecisionError =
  | "application_not_found"
  | "already_approved"
  | "already_rejected"
  | "already_decided";

export type ApplicationDecisionResult =
  | { ok: true; userId: string }
  | { ok: false; error: ApplicationDecisionError };

type AppRow = {
  id: string;
  user_id: string;
  status: string;
  requested_handle: string | null;
  email: string | null;
  username: string | null;
  display_name: string | null;
};

function conflict(status: string): ApplicationDecisionResult {
  if (status === "approved") return { ok: false, error: "already_approved" };
  if (status === "rejected") return { ok: false, error: "already_rejected" };
  return { ok: false, error: "already_decided" };
}

export async function decideCreatorApplication(args: {
  applicationId: string;
  decision: "approve" | "reject";
  reason: string | null;
  actorUserId: string | null;
}): Promise<ApplicationDecisionResult> {
  const { applicationId: id, decision, reason, actorUserId } = args;

  return withTransaction<ApplicationDecisionResult>(async (q) => {
    const { rows } = await q<AppRow>(
      `SELECT ca.id, ca.user_id, ca.status, ca.requested_handle, u.email, u.username, u.display_name
         FROM creator_applications ca
         JOIN users u ON u.id = ca.user_id
        WHERE ca.id = $1
        LIMIT 1
          FOR UPDATE OF ca`,
      [id],
    );
    const app = rows[0];
    if (!app) return { ok: false, error: "application_not_found" };
    if (!(PENDING_APPLICATION_STATUSES as readonly string[]).includes(app.status)) return conflict(app.status);

    const meta = JSON.stringify({
      source: "admin_applications_page",
      kind: "application_decision",
      decision: decision === "approve" ? "approved" : "rejected",
      application_id: id,
    });

    if (decision === "approve") {
      const upd = await q(
        `UPDATE creator_applications
            SET status = 'approved', reviewed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND ${PENDING_SQL}`,
        [id],
      );
      if (upd.rowCount === 0) return conflict(app.status);
      await q(
        `UPDATE users
            SET role = CASE WHEN role IN ('admin', 'moderator') THEN role ELSE 'creator' END,
                updated_at = NOW()
          WHERE id = $1`,
        [app.user_id],
      );
      if (app.email) {
        await q(
          `INSERT INTO creators (name, email, social_link, followers, status, metadata)
           VALUES ($1, $2, $3, $4, 'approved', $5::jsonb)
           ON CONFLICT (email) DO UPDATE
             SET status = 'approved', updated_at = NOW()`,
          [
            app.display_name || app.username || app.requested_handle || app.email.split("@")[0],
            app.email,
            "",
            "0",
            JSON.stringify({ source: "admin_applications", user_id: app.user_id, application_id: id }),
          ],
        );
      }
      await q(
        `INSERT INTO moderation_actions (actor_user_id, target_user_id, action_type, reason, metadata)
         VALUES ($1, $2, 'restore', 'creator_application_approved', $3::jsonb)`,
        [actorUserId, app.user_id, meta],
      );
    } else {
      const upd = await q(
        `UPDATE creator_applications
            SET status = 'rejected',
                review_note = $2,
                reviewed_at = NOW(),
                updated_at = NOW(),
                metadata = COALESCE(metadata, '{}'::jsonb)
                           || jsonb_build_object('reject_reason', $2::text)
          WHERE id = $1 AND ${PENDING_SQL}`,
        [id, reason],
      );
      if (upd.rowCount === 0) return conflict(app.status);
      await q(
        `INSERT INTO moderation_actions (actor_user_id, target_user_id, action_type, reason, metadata)
         VALUES ($1, $2, 'warn', $3, $4::jsonb)`,
        [actorUserId, app.user_id, reason, meta],
      );
    }
    return { ok: true, userId: app.user_id };
  });
}
