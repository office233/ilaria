/**
 * POST /api/push/subscribe
 * Body: { endpoint, keys: { p256dh, auth }, platform? }
 * Upsert în `user_push_tokens` (re-subscribe reactivează tokenul revocat).
 * Auth: getAuthSession (cookie sau Bearer).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KNOWN_PUSH_HOSTS = [
  ".push.services.mozilla.com",
  ".notify.windows.com",
  ".push.apple.com",
  "fcm.googleapis.com",
  "android.googleapis.com",
];

const SubscribeSchema = z.object({
  endpoint: z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine((value) => {
      try {
        const u = new URL(value);
        if (u.protocol !== "https:") return false;
        const host = u.hostname.toLowerCase();
        return KNOWN_PUSH_HOSTS.some((h) =>
          h.startsWith(".") ? host.endsWith(h) : host === h,
        );
      } catch {
        return false;
      }
    }, "endpoint necunoscut"),
  keys: z.object({
    p256dh: z.string().trim().min(1).max(512),
    auth: z.string().trim().min(1).max(256),
  }),
  platform: z.enum(["web", "android", "ios"]).default("web"),
});

export async function POST(req: Request) {
  try {
    const session = await getAuthSession();
    if (!session?.userId) {
      return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("pushSubscribe", session.userId);
    if (!rl.success) {
      return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
    }

    const raw = await req.json().catch(() => null);
    const parsed = SubscribeSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: "invalid_input" }, { status: 400 });
    }
    const { endpoint, keys, platform } = parsed.data;

    const { rows } = await dbQuery<{ id: string }>(
      `INSERT INTO user_push_tokens (user_id, endpoint, p256dh, auth, platform)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id    = EXCLUDED.user_id,
         p256dh     = EXCLUDED.p256dh,
         auth       = EXCLUDED.auth,
         platform   = EXCLUDED.platform,
         revoked_at = NULL
       RETURNING id`,
      [session.userId, endpoint, keys.p256dh, keys.auth, platform],
    );

    logger.info({ userId: session.userId, platform }, "push.subscribe");
    return NextResponse.json({ success: true, id: rows[0]?.id ?? null });
  } catch (err) {
    logger.error({ error: (err as Error).message }, "push.subscribe.error");
    return NextResponse.json({ success: false, error: "internal_error" }, { status: 500 });
  }
}
