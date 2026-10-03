import { withErrorHandling } from "@/lib/api-handler";
/**
 * POST /api/cart/merge — explicit merge of anon cart (cookie) into user cart.
 * Normally called automatically by /api/auth on login; this is a safety net.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { CART_COOKIE, mergeAnonCartToUser } from "@/lib/cart/session";
import { rateLimit } from "@/lib/security/rate-limit";

const NO_STORE = { "Cache-Control": "private, no-store" } as Record<string, string>;

async function POST_impl() {
  const auth = await getAuthUser();
  if (!auth.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  const rl = await rateLimit("cartMerge", auth.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });

  const store = await cookies();
  const token = store.get(CART_COOKIE)?.value;
  if (!token) return NextResponse.json({ success: true, merged: false }, { headers: NO_STORE });
  await mergeAnonCartToUser(token, auth.userId);
  return NextResponse.json({ success: true, merged: true }, { headers: NO_STORE });
}

export const POST = withErrorHandling(POST_impl);
