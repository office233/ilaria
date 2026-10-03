import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { getOrCreateReferralCode } from "@/lib/referral/attribution";
import { dbQuery } from "@/lib/db";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

function siteBase(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

async function GET_impl(req: Request) {
  const auth = await getAuthUser();
  if (!auth?.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const code = await getOrCreateReferralCode(auth.userId);
  const stats = await dbQuery<{
    total_invited: number;
    total_validated: number;
  }>(
    `SELECT total_invited, total_validated FROM referral_codes WHERE user_id = $1`,
    [auth.userId],
  );
  const row = stats.rows[0];
  return NextResponse.json({
    code,
    shareUrl: `${siteBase(req)}/r/${code}`,
    totalInvited: row?.total_invited ?? 0,
    totalValidated: row?.total_validated ?? 0,
  });
}

async function POST_impl(req: Request) {
  const auth = await getAuthUser();
  if (!auth?.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimit("referralGet", auth.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  return GET(req);
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
