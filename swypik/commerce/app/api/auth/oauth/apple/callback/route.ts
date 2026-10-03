import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  createRemoteJWKSet,
  jwtVerify,
  SignJWT,
  importPKCS8,
} from "jose";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_NEXT_COOKIE,
  clearStateCookie,
  findOrCreateUserFromOAuth,
  issueOAuthSessionCookie,
  getOAuthRedirectBase,
  isSafeRedirect,
} from "@/lib/auth/oauth/helpers";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const APPLE_JWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys"),
);

type AppleIdToken = {
  sub: string;
  email?: string;
  email_verified?: string | boolean;
};

function decodeApplePrivateKey(): string {
  const raw = process.env.APPLE_PRIVATE_KEY || "";
  if (!raw) throw new Error("APPLE_PRIVATE_KEY missing");
  if (raw.includes("BEGIN PRIVATE KEY")) return raw.replace(/\n/g, "\n");
  // Assume base64 of .p8 contents
  return Buffer.from(raw, "base64").toString("utf8");
}

async function buildAppleClientSecret(): Promise<string> {
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const clientId = process.env.APPLE_CLIENT_ID;
  if (!teamId || !keyId || !clientId) {
    throw new Error("Apple OAuth env missing (TEAM_ID/KEY_ID/CLIENT_ID)");
  }
  const pkcs8 = decodeApplePrivateKey();
  const key = await importPKCS8(pkcs8, "ES256");
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 60 * 24 * 180) // 6 months
    .setAudience("https://appleid.apple.com")
    .setSubject(clientId)
    .sign(key);
}

async function handle(req: Request, params: URLSearchParams, userJson?: string) {
  const rl = await rateLimit("oauthCallback", `apple:${getClientIP(req)}`);
  if (!rl.success) {
    return NextResponse.redirect(`${getOAuthRedirectBase()}/auth?error=rate_limited`);
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    return NextResponse.json({ error: "missing code/state" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const expected = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  if (!expected || expected !== `apple.${state}`) {
    return NextResponse.json({ error: "state mismatch" }, { status: 400 });
  }
  const nextPath = cookieStore.get(OAUTH_NEXT_COOKIE)?.value || "/";

  const clientId = process.env.APPLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "apple not configured" }, { status: 503 });
  }

  let clientSecret: string;
  try {
    clientSecret = await buildAppleClientSecret();
  } catch (err) {
    logger.error({ err }, "[oauth/apple] secret build failed");
    return NextResponse.redirect(`${getOAuthRedirectBase()}/auth?error=apple_config`);
  }

  const redirectUri = `${getOAuthRedirectBase()}/api/auth/oauth/apple/callback`;
  const tokenRes = await fetch("https://appleid.apple.com/auth/token", {
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
    logger.error({ text }, "[oauth/apple] token exchange failed");
    return NextResponse.redirect(`${getOAuthRedirectBase()}/auth?error=oauth_token`);
  }
  const tokenJson = (await tokenRes.json()) as { id_token?: string };
  if (!tokenJson.id_token) {
    return NextResponse.redirect(`${getOAuthRedirectBase()}/auth?error=oauth_no_id_token`);
  }

  let payload: AppleIdToken;
  try {
    const { payload: verified } = await jwtVerify(tokenJson.id_token, APPLE_JWKS, {
      audience: clientId,
      issuer: "https://appleid.apple.com",
    });
    payload = verified as AppleIdToken;
  } catch (err) {
    logger.error({ err }, "[oauth/apple] verify failed");
    return NextResponse.redirect(`${getOAuthRedirectBase()}/auth?error=oauth_verify`);
  }

  // Apple gives `user` JSON only on first login (POST form `user` field).
  let displayName: string | null = null;
  if (userJson) {
    try {
      const parsed = JSON.parse(userJson) as { name?: { firstName?: string; lastName?: string } };
      const fn = parsed.name?.firstName || "";
      const ln = parsed.name?.lastName || "";
      const full = `${fn} ${ln}`.trim();
      if (full) displayName = full;
    } catch {
      /* ignore */
    }
  }

  const emailVerified =
    payload.email_verified === true || payload.email_verified === "true";

  const { userId } = await findOrCreateUserFromOAuth(
    {
      provider: "apple",
      providerUserId: payload.sub,
      email: payload.email || null,
      emailVerified,
      displayName,
      avatarUrl: null,
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
  const res = NextResponse.redirect(`${getOAuthRedirectBase()}${safeNext}`, 303);
  res.headers.append("Set-Cookie", sessionCookie);
  res.headers.append("Set-Cookie", clearStateCookie());
  res.headers.append(
    "Set-Cookie",
    `${OAUTH_NEXT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
  );
  return res;
}

export async function POST(req: Request) {
  const form = await req.formData();
  const params = new URLSearchParams();
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") params.set(k, v);
  }
  const userJson = params.get("user") || undefined;
  return handle(req, params, userJson);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  return handle(req, url.searchParams);
}
