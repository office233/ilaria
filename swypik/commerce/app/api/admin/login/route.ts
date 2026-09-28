/**
 * POST /api/admin/login — acces de URGENȚĂ („break glass”), nu login obișnuit.
 *
 * Adminii intră cu contul lor Swypik (/login, cod OTP) — sesiunea de admin se
 * emite acolo. Ruta asta funcționează doar cu ADMIN_BREAK_GLASS_ENABLED=1 și
 * cere ADMIN_SECRET + emailul unui cont care e deja admin: sesiunea rezultată
 * e legată de acel admin (kind 'break_glass'), deci auditul știe cine a fost.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import {
  createAdminSessionAndGetCookie,
  isAdminToken,
  isBreakGlassEnabled,
} from "@/lib/security/admin-auth";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";
import { normalizeAdminRole } from "@/lib/admin/permissions";

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(512),
});

export async function POST(req: Request) {
  try {
    if (!isBreakGlassEnabled()) {
      return NextResponse.json({ success: false, error: "break_glass_disabled" }, { status: 403 });
    }

    const { success: allowed } = await rateLimit("admin-login", getClientIP(req), { limit: 5, window: 300 });
    if (!allowed) {
      return NextResponse.json({ success: false, error: "too_many_attempts" }, { status: 429 });
    }

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: "invalid_body" }, { status: 400 });
    }
    const { email, password } = parsed.data;

    const { rows } = await dbQuery<{ id: string; admin_role: string | null }>(
      `SELECT id::text, admin_role FROM users
        WHERE lower(email) = $1 AND role = 'admin'
          AND (suspended_until IS NULL OR suspended_until <= now())
        LIMIT 1`,
      [email],
    );
    const adminUser = rows[0];

    // Același răspuns pentru „secret greșit” și „cont care nu e admin”.
    if (!isAdminToken(password) || !adminUser) {
      await logAdminAction({
        action: "admin.break_glass_failed",
        actorKind: "anonymous",
        details: { email },
        req,
      });
      return NextResponse.json({ success: false, error: "invalid_credentials" }, { status: 401 });
    }

    const cookieHeader = await createAdminSessionAndGetCookie({ userId: adminUser.id, kind: "break_glass", req });
    const response = NextResponse.json({ success: true });
    response.headers.set("Set-Cookie", cookieHeader);
    await logAdminAction({
      action: "admin.break_glass_login",
      targetType: "user",
      targetId: adminUser.id,
      actor: {
        kind: "break_glass",
        userId: adminUser.id,
        email,
        username: null,
        role: normalizeAdminRole(adminUser.admin_role),
        sessionHash: null,
      },
      req,
    });
    return response;
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : error }, "[admin/login] break-glass failed");
    return NextResponse.json({ success: false, error: "login_failed" }, { status: 500 });
  }
}
