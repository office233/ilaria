import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import {
  getAdminActorFromRequest,
  getClearAdminCookieHeader,
  readAdminTokenFromCookieHeader,
  revokeAdminSessionToken,
} from "@/lib/security/admin-auth";
import { logAdminAction } from "@/lib/security/admin-audit";

/** POST /api/admin/logout — revocă sesiunea de admin curentă (contul Swypik rămâne logat). */
async function POST_impl(req: Request) {
  const token = readAdminTokenFromCookieHeader(req.headers.get("cookie"));
  if (token) {
    const actor = await getAdminActorFromRequest(req);
    await revokeAdminSessionToken(token);
    if (actor) await logAdminAction({ action: "admin.logout", actor, req });
  }
  const response = NextResponse.json({ success: true });
  response.headers.set("Set-Cookie", getClearAdminCookieHeader());
  return response;
}

export const POST = withErrorHandling(POST_impl);
