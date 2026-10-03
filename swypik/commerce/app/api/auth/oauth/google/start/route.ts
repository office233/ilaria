import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import crypto from "crypto";
import {
  buildStateCookie,
  getOAuthRedirectBase,
  isSafeRedirect,
} from "@/lib/auth/oauth/helpers";

export const dynamic = "force-dynamic";

async function GET_impl(req: Request) {
  const url = new URL(req.url);
  const next = isSafeRedirect(url.searchParams.get("next"));
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Google OAuth not configured" },
      { status: 503 },
    );
  }
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${getOAuthRedirectBase()}/api/auth/oauth/google/callback`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "online");
  authUrl.searchParams.set("prompt", "select_account");

  const res = NextResponse.redirect(authUrl.toString());
  res.headers.append("Set-Cookie", buildStateCookie(state, "google"));
  const isProd = process.env.NODE_ENV === "production";
  res.headers.append(
    "Set-Cookie",
    `swypik_oauth_next=${encodeURIComponent(next)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${isProd ? "; Secure" : ""}`,
  );
  return res;
}

export const GET = withErrorHandling(GET_impl);
