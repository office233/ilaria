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
  const clientId = process.env.APPLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Apple OAuth not configured" },
      { status: 503 },
    );
  }
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${getOAuthRedirectBase()}/api/auth/oauth/apple/callback`;
  const authUrl = new URL("https://appleid.apple.com/auth/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("response_mode", "form_post");
  authUrl.searchParams.set("scope", "email name");
  authUrl.searchParams.set("state", state);

  const res = NextResponse.redirect(authUrl.toString());
  // SameSite=None required because Apple POSTs the form from a different origin
  const isProd = process.env.NODE_ENV === "production";
  const secure = isProd ? "; Secure" : "";
  res.headers.append(
    "Set-Cookie",
    `swypik_oauth_state=apple.${state}; Path=/; HttpOnly; SameSite=None; Max-Age=600${secure}`,
  );
  res.headers.append(
    "Set-Cookie",
    `swypik_oauth_next=${encodeURIComponent(next)}; Path=/; HttpOnly; SameSite=None; Max-Age=600${secure}`,
  );
  return res;
}

export const GET = withErrorHandling(GET_impl);
