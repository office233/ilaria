import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";

/**
 * POST /api/onboarding/skip
 *
 * Marchează utilizatorul ca având onboarding-ul finalizat fără a salva interese.
 * Folosit de butonul "Sari peste" pe pagina /onboarding.
 */
async function POST_impl(req: Request) {
  const rl = await rateLimit("onboarding", getClientIP(req));
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const response = NextResponse.json({ ok: true });

  response.cookies.set("swypik_onboarded", "1", {
    path: "/",
    maxAge: 60 * 60 * 24 * 730, // 2 years
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: false,
  });

  return response;
}

export const POST = withErrorHandling(POST_impl);
