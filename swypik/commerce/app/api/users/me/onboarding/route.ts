import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Starea onboarding-ului pentru OnboardingGate (client). Înainte era citită
// server-side în root layout, ceea ce făcea dinamică fiecare pagină.
export async function GET() {
  try {
    const auth = await getAuthUser();
    if (!auth.userId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const { rows } = await dbQuery<{ onboarding_completed_at: string | null }>(
      `SELECT onboarding_completed_at FROM users WHERE id = $1 LIMIT 1`,
      [auth.userId],
    );
    const needed = Boolean(rows[0]) && !rows[0].onboarding_completed_at;
    return NextResponse.json(
      { ok: true, needed },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    logger.error({ err: error }, "[onboarding] status error");
    return NextResponse.json({ ok: false, error: "Internal Server Error" }, { status: 500 });
  }
}
