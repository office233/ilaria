import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_NEXT_COOKIE,
  clearStateCookie,
  findOrCreateUserFromOAuth,
  issueOAuthSessionCookie,
  getOAuthRedirectBase,
  isSafeRedirect,
} from "@/lib/auth/oauth/helpers";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

type GoogleIdToken = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(`${getOAuthRedirectBase()}/auth?error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return NextResponse.json({ error: "missing code/state" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const expected = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  if (!expected || expected !== `google.${state}`) {
    return NextResponse.json({ error: "state mismatch" }, { status: 400 });
  }
  const nextPath = cookieStore.get(OAUTH_NEXT_COOKIE)?.value || "/";

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "google not configured" }, { status: 503 });
  }

  const redirectUri = `${getOAuthRedirectBase()}/api/auth/oauth/google/callback`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    logger.error({ text }, "[oauth/google] token exchange failed");
    return NextResponse.redirect(`${getOAuthRedirectBase()}/auth?error=oauth_token`);
  }
  const tokenJson = (await tokenRes.json()) as { id_token?: string };
  if (!tokenJson.id_token) {
    return NextResponse.redirect(`${getOAuthRedirectBase()}/auth?error=oauth_no_id_token`);
  }

  let payload: GoogleIdToken;
  try {
    const { payload: verified } = await jwtVerify(tokenJson.id_token, GOOGLE_JWKS, {
      audience: clientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
    });
    payload = verified as GoogleIdToken;
  } catch (err) {
    logger.error({ err }, "[oauth/google] verify failed");
    return NextResponse.redirect(`${getOAuthRedirectBase()}/auth?error=oauth_verify`);
  }

  if (!payload.sub) {
    return NextResponse.redirect(`${getOAuthRedirectBase()}/auth?error=oauth_no_sub`);
  }

  const { userId } = await findOrCreateUserFromOAuth(
    {
      provider: "google",
      providerUserId: payload.sub,
      email: payload.email || null,
      emailVerified: Boolean(payload.email_verified),
      displayName: payload.name || null,
      avatarUrl: payload.picture || null,
    },
    {
      ip:
        req.headers.get("cf-connecting-ip") ||
        (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
        null,
      ipCountry: req.headers.get("cf-ipcountry"),
      userAgent: req.headers.get("user-agent"),
    },
  );

  const sessionCookie = await issueOAuthSessionCookie(userId);
  const safeNext = isSafeRedirect(nextPath);
  const res = NextResponse.redirect(`${getOAuthRedirectBase()}${safeNext}`);
  res.headers.append("Set-Cookie", sessionCookie);
  res.headers.append("Set-Cookie", clearStateCookie());
  res.headers.append(
    "Set-Cookie",
    `${OAUTH_NEXT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
  );
  return res;
}
