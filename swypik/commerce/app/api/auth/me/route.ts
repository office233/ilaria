/**
 * GET /api/auth/me — Returns the current session user (or 401 if guest).
 *
 * Response 200:
 *   {
 *     ok: true,
 *     user: {
 *       userId: string,
 *       role: "shopper"|"creator"|"seller"|"admin",
 *       email: string|null,
 *       username: string|null,
 *       displayName: string|null,
 *       avatarUrl: string|null,
 *       isAdmin: boolean,
 *       sellerId: string|null
 *     }
 *   }
 *
 * Response 401: { ok: false, user: null } — no valid session.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { getAuthSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

type ProfileRow = {
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export async function GET() {
  let auth = await getAuthUser();
  // Preserve the existing seller/admin cookie identity; mobile fallback is for guests only.
  if (auth.role === "guest") {
    const session = await getAuthSession();
    if (session) auth = {
      userId: session.userId, role: session.role, email: session.email,
      sellerId: session.sellerId ?? null, isAdmin: session.role === "admin",
    };
  }
  if (!auth.userId) {
    return NextResponse.json(
      { ok: false, user: null },
      {
        status: 401,
        headers: {
          "cache-control": "no-store, max-age=0",
        },
      },
    );
  }

  let username: string | null = null;
  let displayName: string | null = null;
  let avatarUrl: string | null = null;

  try {
    const { rows } = await dbQuery<ProfileRow>(
      `SELECT username, display_name, avatar_url FROM users WHERE id=$1 LIMIT 1`,
      [auth.userId],
    );
    if (rows[0]) {
      username = rows[0].username;
      displayName = rows[0].display_name;
      avatarUrl = rows[0].avatar_url;
    }
  } catch (err) {
    logger.warn({ err }, "[auth/me] profile lookup failed");
  }

  return NextResponse.json(
    {
      ok: true,
      user: {
        userId: auth.userId,
        role: auth.role,
        email: auth.email,
        username,
        displayName,
        avatarUrl,
        isAdmin: auth.isAdmin,
        sellerId: auth.sellerId,
      },
    },
    {
      headers: {
        "cache-control": "no-store, max-age=0",
      },
    },
  );
}
