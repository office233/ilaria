/**
 * Lista de utilizatori pentru /admin/users: căutare (username/email/nume),
 * filtru de stare, paginare. SQL parametrizat.
 */
import { dbQuery } from "@/lib/db";

export const USERS_PAGE_SIZE = 50;
export const USER_STATUS_FILTERS = ["all", "active", "suspended", "admin"] as const;
export type UserStatusFilter = (typeof USER_STATUS_FILTERS)[number];

export function parseUserStatus(v: string | undefined): UserStatusFilter {
  return (USER_STATUS_FILTERS as readonly string[]).includes(v ?? "") ? (v as UserStatusFilter) : "all";
}

export type AdminUserRow = {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  role: string;
  admin_role: string | null;
  is_verified: boolean;
  suspended_until: string | null;
  suspension_reason: string | null;
  created_at: string;
  active_sessions: number;
  videos_count: number;
};

const STATUS_SQL: Record<UserStatusFilter, string> = {
  all: "TRUE",
  active: "(u.suspended_until IS NULL OR u.suspended_until < now())",
  suspended: "(u.suspended_until IS NOT NULL AND u.suspended_until > now())",
  admin: "(u.role = 'admin')",
};

export async function listAdminUsers(opts: {
  q: string | null;
  status: UserStatusFilter;
  page: number;
}): Promise<{ rows: AdminUserRow[]; total: number }> {
  const params: unknown[] = [];
  let search = "";
  if (opts.q) {
    params.push(`%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    search = `AND (u.username ILIKE $1 OR u.email ILIKE $1 OR u.display_name ILIKE $1)`;
  }
  const where = `WHERE ${STATUS_SQL[opts.status]} ${search}`;
  const limitIdx = params.length + 1;
  const [list, count] = await Promise.all([
    dbQuery<AdminUserRow>(
      `SELECT u.id::text, u.username, u.email, u.display_name, u.avatar_url, u.role, u.admin_role, u.is_verified,
              u.suspended_until::text, u.suspension_reason, u.created_at::text,
              (SELECT COUNT(*)::int FROM user_sessions s
                WHERE s.user_id = u.id AND s.expires_at > now() AND s.revoked_at IS NULL) AS active_sessions,
              (SELECT COUNT(*)::int FROM videos v WHERE v.creator_id = u.id) AS videos_count
         FROM users u
         ${where}
        ORDER BY u.created_at DESC
        LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`,
      [...params, USERS_PAGE_SIZE, (opts.page - 1) * USERS_PAGE_SIZE],
    ),
    dbQuery<{ c: number }>(`SELECT COUNT(*)::int AS c FROM users u ${where}`, params),
  ]);
  return { rows: list.rows, total: Number(count.rows[0]?.c ?? 0) };
}

export function isSuspended(row: Pick<AdminUserRow, "suspended_until">, now = new Date()): boolean {
  return Boolean(row.suspended_until && new Date(row.suspended_until) > now);
}
