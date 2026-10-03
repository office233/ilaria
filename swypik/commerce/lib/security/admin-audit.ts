/**
 * Admin action audit log — records every mutation performed from the admin panel
 * (who, what, on which object, when) into `admin_audit_log`.
 *
 * The actor is the named admin behind the request (per-admin session), a
 * machine (`Bearer ADMIN_SECRET`), or anonymous. Historical rows may still
 * carry `erp` (Multi-ERP, retired 2026-09-28). Callers that already resolved the actor (requireAdmin) pass it explicitly.
 *
 * Non-blocking: a failure to write the log is reported via the logger but never
 * fails the admin action itself.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  getAdminActor,
  getAdminActorFromRequest,
  type AdminActor,
} from "@/lib/security/admin-auth";

export type AuditActorKind = AdminActor["kind"] | "anonymous";

export type AdminAuditEntry = {
  /** Dotted verb, e.g. "order.refund", "user.role_change", "video.remove". */
  action: string;
  targetType?: string;
  targetId?: string | number | null;
  /** Small JSON-serialisable context (old/new values, reason). Never secrets. */
  details?: Record<string, unknown>;
  /** The incoming request, used for the client IP and to resolve the actor. */
  req?: Request;
  /** Already-resolved actor (skips the lookup). */
  actor?: AdminActor | null;
  /** Non-admin callers (e.g. failed logins) name themselves. */
  actorKind?: AuditActorKind;
};

function clientIp(req?: Request): string | null {
  if (!req) return null;
  const h = req.headers;
  return (
    h.get("cf-connecting-ip") ||
    h.get("x-real-ip") ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
}

async function resolveActor(entry: AdminAuditEntry): Promise<AdminActor | null> {
  if (entry.actor !== undefined) return entry.actor;
  if (entry.actorKind) return null;
  try {
    return entry.req ? await getAdminActorFromRequest(entry.req) : await getAdminActor();
  } catch {
    return null;
  }
}

export async function logAdminAction(entry: AdminAuditEntry): Promise<void> {
  try {
    const actor = await resolveActor(entry);
    const kind: AuditActorKind = entry.actorKind ?? actor?.kind ?? "anonymous";
    await dbQuery(
      `INSERT INTO admin_audit_log (actor_user_id, actor_kind, actor_role, action, target_type, target_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        actor?.userId ?? null,
        kind,
        actor?.role ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId == null ? null : String(entry.targetId),
        JSON.stringify(entry.details ?? {}),
        clientIp(entry.req),
      ],
    );
  } catch (err) {
    logger.error({ err, action: entry.action }, "[admin-audit] failed to write audit log");
  }
}
