/**
 * GET /api/admin/session — 204 dacă cookie-ul admin_token e o sesiune de admin
 * validă (neexpirată, nerevocată, cont încă admin), altfel 401.
 *
 * Folosită de middleware.ts ca să respingă devreme cererile de pagini /admin/*
 * cu un token inventat sau revocat (inclusiv cererile RSC parțiale). Gărzile
 * reale rămân requireAdminPage/requireAdmin în fiecare pagină/rută.
 */
import { NextResponse } from "next/server";
import { readAdminTokenFromCookieHeader, resolveAdminSessionToken } from "@/lib/security/admin-auth";
import { NO_STORE } from "@/lib/http/cache-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = readAdminTokenFromCookieHeader(req.headers.get("cookie"));
  const actor = token ? await resolveAdminSessionToken(token).catch(() => null) : null;
  return new NextResponse(null, {
    status: actor ? 204 : 401,
    headers: { "Cache-Control": NO_STORE },
  });
}
