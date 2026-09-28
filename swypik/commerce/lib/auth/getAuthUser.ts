import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import crypto from "crypto";
import { dbQuery } from "@/lib/db";
import { getAdminCookieName, isAdminToken, resolveAdminSessionToken, type AdminActor } from "@/lib/security/admin-auth";
import { isSessionTokenFormat } from "@/lib/auth/session";

export type AuthRole = "shopper" | "creator" | "seller" | "admin" | "guest";

export type AuthUser = {
  role: AuthRole;
  userId: string | null;
  sellerId: string | null;
  isAdmin: boolean;
  email: string | null;
};

const SHOPPER_COOKIE = "swypik_session";
const SELLER_COOKIE = "seller_session";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function resolveUserBySession(token: string): Promise<{ userId: string; role: string; email: string | null } | null> {
  if (!isSessionTokenFormat(token)) return null;
  const { rows } = await dbQuery<{ user_id: string; role: string; email: string | null }>(
    `SELECT s.user_id, u.role, u.email
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.session_token_hash = $1
        AND COALESCE(s.metadata->>'type', 'session') = 'session'
        AND s.expires_at > now()
        AND s.revoked_at IS NULL
      LIMIT 1`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return { userId: row.user_id, role: row.role || "shopper", email: row.email };
}

async function resolveSellerBySession(token: string): Promise<string | null> {
  const { rows } = await dbQuery<{ seller_id: string }>(
    `SELECT seller_id FROM seller_sessions
      WHERE token = $1 AND expires_at > now()
      LIMIT 1`,
    [sha256(token)],
  );
  return rows[0]?.seller_id ?? null;
}

/** Sesiunea de admin e legată de un cont (migrarea 20260926_0100). */
async function resolveAdminBySession(token: string): Promise<AdminActor | null> {
  return resolveAdminSessionToken(token);
}

const GUEST: AuthUser = { role: "guest", userId: null, sellerId: null, isAdmin: false, email: null };

export async function getAuthUser(): Promise<AuthUser> {
  const store = await cookies();

  const adminToken = store.get(getAdminCookieName())?.value;
  const adminActor = adminToken ? await resolveAdminBySession(adminToken).catch(() => null) : null;

  const sellerToken = store.get(SELLER_COOKIE)?.value;
  const sellerId = sellerToken ? await resolveSellerBySession(sellerToken).catch(() => null) : null;

  const shopperToken = store.get(SHOPPER_COOKIE)?.value;
  const userInfo = shopperToken ? await resolveUserBySession(shopperToken).catch(() => null) : null;

  if (adminActor) {
    return {
      role: "admin",
      userId: adminActor.userId ?? userInfo?.userId ?? null,
      sellerId,
      isAdmin: true,
      email: adminActor.email ?? userInfo?.email ?? null,
    };
  }

  if (sellerId) {
    return { role: "seller", userId: userInfo?.userId ?? null, sellerId, isAdmin: false, email: userInfo?.email ?? null };
  }

  if (userInfo) {
    const role = (userInfo.role === "creator" ? "creator" : "shopper") as AuthRole;
    return { role, userId: userInfo.userId, sellerId: null, isAdmin: false, email: userInfo.email };
  }

  return GUEST;
}

export async function requireRole(roles: AuthRole[]): Promise<AuthUser> {
  const user = await getAuthUser();
  if (!roles.includes(user.role)) {
    throw new Error(`Forbidden: requires one of [${roles.join(", ")}], got ${user.role}`);
  }
  return user;
}

/**
 * Route-handler guard. Returns either AuthUser or a NextResponse 401/403.
 * Usage:
 *   const auth = await requireAuth(req, ['admin']);
 *   if (auth instanceof NextResponse) return auth;
 *   // auth is AuthUser
 *
 * For 'admin', also accepts `Authorization: Bearer <ADMIN_SECRET>` (preserves API/curl usage).
 */
export async function requireAuth(req: Request, roles: AuthRole[]): Promise<AuthUser | NextResponse> {
  if (roles.includes("admin")) {
    const authHeader = req.headers.get("authorization");
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    if (bearer && isAdminToken(bearer)) {
      return { role: "admin", userId: null, sellerId: null, isAdmin: true, email: null };
    }
  }
  const user = await getAuthUser();
  if (user.role === "guest") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!roles.includes(user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return user;
}
