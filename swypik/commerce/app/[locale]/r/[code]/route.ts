import { NextResponse } from "next/server";
import { setReferralCookie } from "@/lib/referral/attribution";

export const dynamic = "force-dynamic";

/**
 * Public landing for short referral links: /r/<CODE>
 * Sets `swypik_ref` cookie (90 days) and redirects to home.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ code: string }> },
) {
  const { code } = await ctx.params;
  const norm = (code || "").toUpperCase();
  if (/^[A-Z0-9]{6,12}$/.test(norm)) {
    await setReferralCookie(norm);
  }
  const url = new URL("/", _req.url);
  return NextResponse.redirect(url, 302);
}
