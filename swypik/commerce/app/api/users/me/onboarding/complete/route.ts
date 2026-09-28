import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const auth = await getAuthUser();
    if (!auth.userId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const rl = await rateLimit("onboardingComplete", auth.userId);
    if (!rl.success) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
    await dbQuery(
      `UPDATE users SET onboarding_completed_at = COALESCE(onboarding_completed_at, now()) WHERE id = $1`,
      [auth.userId],
    );
    const response = NextResponse.json({ ok: true });
    // Persist the onboarded cookie so the modal doesn't re-appear on next nav.
    response.cookies.set("swypik_onboarded", "1", {
      path: "/",
      maxAge: 60 * 60 * 24 * 730,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
    });
    return response;
  } catch (error) {
    logger.error({ err: error }, "[onboarding/complete] error");
    return NextResponse.json({ ok: false, error: "Internal Server Error" }, { status: 500 });
  }
}
