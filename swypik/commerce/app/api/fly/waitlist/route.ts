/**
 * POST /api/fly/waitlist { email, destination?, origin?, locale? } — înscriere
 * în lista „anunță-mă” pentru lansarea Swypik Fly. Public, rate-limited pe IP,
 * cu câmp-capcană anti-bot. Răspuns identic pentru email nou sau existent.
 */
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { getAuthSession } from "@/lib/auth/session";
import { joinWaitlist, waitlistSchema } from "@/lib/fly/waitlist";
import { logger } from "@/lib/logger";
import { getClientIP, rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withErrorHandling(async function POST(req: Request) {
    const rl = await rateLimit("fly:waitlist", getClientIP(req), { limit: 5, window: 3600 });
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = waitlistSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    // Capcana completată → răspundem „ok” fără să salvăm nimic.
    if (parsed.data.website) return NextResponse.json({ ok: true });

    const session = await getAuthSession().catch(() => null);
    await joinWaitlist(parsed.data, session?.userId ?? null);
    logger.info({ hasUser: Boolean(session) }, "fly waitlist signup");
    return NextResponse.json({ ok: true });
});
