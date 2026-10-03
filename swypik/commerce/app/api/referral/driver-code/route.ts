/**
 * POST /api/referral/driver-code { code } — leagă utilizatorul logat de un
 * șofer prin codul de invitație (SWK...). Eligibil: cont fără referral
 * existent și fără curse finalizate. Valabilitate 6 luni.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthSession } from "@/lib/auth/session";
import { claimDriverReferral, isDriverReferralCode } from "@/lib/drivers/referral";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const Body = z.object({ code: z.string().trim().min(3).max(16) });

export async function POST(req: Request) {
  try {
    const session = await getAuthSession();
    if (!session?.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_code" }, { status: 400 });
    }
    const code = parsed.data.code.toUpperCase();
    if (!isDriverReferralCode(code)) {
      return NextResponse.json({ error: "not_driver_code" }, { status: 400 });
    }
    const result = await claimDriverReferral(session.userId, code);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "[referral/driver-code] failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
