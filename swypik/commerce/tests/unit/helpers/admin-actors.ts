/**
 * Actori de test pentru rutele de admin (sesiuni per administrator).
 * Folosiți împreună cu un mock pe `@/lib/security/admin-auth` care întoarce
 * actorul curent din `getAdminActorFromRequest` / `getAdminActor`.
 */
import type { AdminActor } from "@/lib/security/admin-auth";

function human(role: AdminActor["role"], userId: string): AdminActor {
  return { kind: "admin_user", userId, email: `${userId}@swypik.test`, username: userId, role, sessionHash: `hash-${userId}` };
}

export const OWNER = human("owner", "00000000-0000-4000-8000-00000000000a");
export const OPS = human("ops", "00000000-0000-4000-8000-00000000000b");
export const MODERATOR = human("moderator", "00000000-0000-4000-8000-00000000000c");
export const SUPPORT = human("support", "00000000-0000-4000-8000-00000000000d");
export const FINANCE = human("finance", "00000000-0000-4000-8000-00000000000e");
export const MACHINE: AdminActor = {
  kind: "machine",
  userId: null,
  email: null,
  username: null,
  role: "machine",
  sessionHash: null,
};

export const TARGET_USER = "11111111-1111-4111-8111-111111111111";
export const TARGET_VIDEO = "22222222-2222-4222-8222-222222222222";
export const TARGET_REPORT = "33333333-3333-4333-8333-333333333333";

export type SqlCall = { sql: string; params: unknown[] };

/** Rândurile scrise în admin_audit_log: [actor_user_id, actor_kind, actor_role, action, target_type, target_id, details, ip]. */
export function auditInserts(calls: SqlCall[]): unknown[][] {
  return calls.filter((c) => c.sql.includes("INSERT INTO admin_audit_log")).map((c) => c.params);
}

export function jsonReq(url: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "10.0.0.1", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}
