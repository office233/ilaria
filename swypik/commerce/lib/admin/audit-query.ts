/**
 * Citirea jurnalului de audit (admin_audit_log) pentru /admin/audit și
 * dashboard. Filtre parametrizate: prefix de acțiune, actor (email/username),
 * țintă (id exact).
 */
import { dbQuery } from "@/lib/db";

export const AUDIT_PAGE_SIZE = 50;

export type AuditRow = {
  id: string;
  actor_user_id: string | null;
  actor_kind: string;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  created_at: string;
  actor_username: string | null;
  actor_email: string | null;
};

export type AuditFilters = {
  action?: string;
  actor?: string;
  target?: string;
};

function buildWhere(f: AuditFilters): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.action) {
    params.push(f.action);
    where.push(`a.action LIKE $${params.length} || '%'`);
  }
  if (f.actor) {
    params.push(f.actor.toLowerCase());
    where.push(`(lower(u.email) = $${params.length} OR lower(u.username) = $${params.length})`);
  }
  if (f.target) {
    params.push(f.target);
    where.push(`a.target_id = $${params.length}`);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export async function listAuditEntries(
  filters: AuditFilters,
  opts: { limit: number; offset?: number },
): Promise<{ rows: AuditRow[]; total: number }> {
  const { sql, params } = buildWhere(filters);
  const from = `FROM admin_audit_log a LEFT JOIN users u ON u.id = a.actor_user_id ${sql}`;
  const limitIdx = params.length + 1;
  const [list, total] = await Promise.all([
    dbQuery<AuditRow>(
      `SELECT a.id::text, a.actor_user_id::text, a.actor_kind, a.actor_role, a.action, a.target_type,
              a.target_id, a.details, a.ip, a.created_at::text,
              u.username AS actor_username, u.email AS actor_email
         ${from}
        ORDER BY a.created_at DESC
        LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`,
      [...params, opts.limit, opts.offset ?? 0],
    ),
    dbQuery<{ c: number }>(`SELECT COUNT(*)::int AS c ${from}`, params),
  ]);
  return { rows: list.rows, total: Number(total.rows[0]?.c ?? 0) };
}

export async function listAuditActionPrefixes(): Promise<string[]> {
  const { rows } = await dbQuery<{ prefix: string }>(
    `SELECT DISTINCT split_part(action, '.', 1) AS prefix FROM admin_audit_log ORDER BY 1`,
  );
  return rows.map((r) => r.prefix);
}

/** Cine a făcut acțiunea, pentru afișare. */
export function auditActorLabel(row: Pick<AuditRow, "actor_email" | "actor_username" | "actor_kind">): string {
  return row.actor_email ?? (row.actor_username ? `@${row.actor_username}` : row.actor_kind);
}
