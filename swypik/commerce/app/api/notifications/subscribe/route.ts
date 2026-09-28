import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import {
  anonSessionErrorResponse,
  getOptionalSocialUserId,
  getOrCreateSocialUser,
  setAnonSessionCookie,
  type SocialUserSession,
} from "@/lib/social/session";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

type SubscribeBody = {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
  userAgent?: string;
};

export async function POST(request: Request) {
  if (!isEnabled("pushNotifications")) return frozenResponse("pushNotifications");
  const rl = await rateLimit("pushSubscribe", getClientIP(request));
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const endpoint = body.endpoint;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;

  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json(
      { error: "missing_subscription_fields" },
      { status: 400 },
    );
  }

  let social: SocialUserSession;
  try {
    social = await getOrCreateSocialUser();
  } catch (err) {
    const anonErr = anonSessionErrorResponse(err);
    if (anonErr) return anonErr;
    throw err;
  }
  const { userId, anonSessionId } = social;
  const ua = body.userAgent || request.headers.get("user-agent") || null;

  await dbQuery(
    `INSERT INTO user_push_tokens (user_id, endpoint, p256dh, auth, platform)
     VALUES ($1, $2, $3, $4, 'web')
     ON CONFLICT (endpoint)
     DO UPDATE SET
       user_id      = EXCLUDED.user_id,
       p256dh       = EXCLUDED.p256dh,
       auth         = EXCLUDED.auth,
       revoked_at   = NULL`,
    [userId, endpoint, p256dh, auth],
  );

  const response = NextResponse.json({ ok: true });
  setAnonSessionCookie(response, anonSessionId);
  return response;
}

export async function DELETE(request: Request) {
  if (!isEnabled("pushNotifications")) return frozenResponse("pushNotifications");
  const rl = await rateLimit("pushSubscribe", getClientIP(request));
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  let body: { endpoint?: string };
  try {
    body = (await request.json()) as { endpoint?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.endpoint) {
    return NextResponse.json({ error: "missing_endpoint" }, { status: 400 });
  }

  // Dezabonarea nu are de ce să creeze o identitate nouă.
  const userId = await getOptionalSocialUserId();
  if (!userId) return NextResponse.json({ ok: true });
  await dbQuery(
    `UPDATE user_push_tokens SET revoked_at = now()
      WHERE endpoint = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [body.endpoint, userId],
  );
  return NextResponse.json({ ok: true });
}
