import crypto from "crypto";
import { cookies } from "next/headers";
import { dbQuery } from "@/lib/db";
import { isSessionTokenFormat } from "@/lib/auth/session";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

const ALLOWED_CREATOR_ROLES = new Set(["creator", "admin"]);

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * @deprecated Use {@link getCreatorUserIdWithRoleCheck} instead. This helper
 * does NOT verify the user has the `creator`/`admin` role and must not be
 * used as the sole authorization gate for creator-only endpoints.
 */
export async function getCreatorUserId(): Promise<string | null> {
  const store = await cookies();
  const sessionToken = store.get("swypik_session")?.value;

  if (isSessionTokenFormat(sessionToken)) {
    const { rows } = await dbQuery<{ user_id: string }>(
      `SELECT user_id
       FROM user_sessions
       WHERE session_token_hash = $1
         AND COALESCE(metadata->>'type', 'session') = 'session'
         AND expires_at > now()
         AND revoked_at IS NULL
       LIMIT 1`,
      [hashToken(sessionToken)],
    );
    if (rows[0]?.user_id) return rows[0].user_id;
  }

  const legacyCreatorId = store.get("creator_session")?.value;
  if (process.env.NODE_ENV !== "production" && legacyCreatorId && UUID_RE.test(legacyCreatorId)) {
    return legacyCreatorId;
  }

  return null;
}

/**
 * Returns the user's role for `userId`, or null if not found.
 */
export async function getUserRole(userId: string): Promise<string | null> {
  const { rows } = await dbQuery<{ role: string }>(
    `SELECT role FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return rows[0]?.role ?? null;
}

/**
 * Throws if the user does not have the `creator` or `admin` role. Use this in
 * route handlers to enforce role-based authorization for creator-only
 * functionality.
 */
export async function assertCreatorRole(userId: string): Promise<{ role: string }> {
  const role = await getUserRole(userId);
  if (!role) {
    const err = new Error("User not found") as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  if (!ALLOWED_CREATOR_ROLES.has(role)) {
    const err = new Error("Creator role required") as Error & { status?: number };
    err.status = 403;
    throw err;
  }
  return { role };
}

/**
 * Resolves the current user's id and verifies they have a creator/admin role.
 * Returns `{ userId, role }` on success, or `null` when the request is
 * unauthenticated or the user lacks the required role.
 *
 * Prefer this over {@link getCreatorUserId} for any creator-protected route.
 */
export async function getCreatorUserIdWithRoleCheck(): Promise<
  { userId: string; role: string } | null
> {
  const userId = await getCreatorUserId();
  if (!userId) return null;
  const role = await getUserRole(userId);
  if (!role || !ALLOWED_CREATOR_ROLES.has(role)) return null;
  return { userId, role };
}
