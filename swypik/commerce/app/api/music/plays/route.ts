import { NextResponse } from "next/server";
import { z } from "zod";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { getTrackById, incrementPlay } from "@/lib/music/repository";
import { shouldCountPlay } from "@/lib/music/plays";
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ trackId: z.string().uuid() });

/**
 * Contor de plays (Review Focus #5): un play per (IP, piesă) în fereastra de
 * dedup din `lib/music/plays.ts`. Redis indisponibil ⇒ numărăm oricum (nu
 * blocăm contorul pentru o eroare infra), dar logăm ca să vedem regresia.
 */
export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("music")) return frozenResponse("music");
    const ip = getClientIP(req);
    const rl = await rateLimit("musicPlays", ip);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    const { trackId } = parsed.data;

    const track = await getTrackById(trackId);
    if (!track || track.status !== "published") return NextResponse.json({ error: "not_found" }, { status: 404 });

    let shouldCount = true;
    try {
        shouldCount = await shouldCountPlay(getRedis(), ip, trackId);
    } catch (err) {
        logger.error({ err, trackId }, "music.plays.redis_error");
        shouldCount = true;
    }
    if (shouldCount) await incrementPlay(trackId);
    return new NextResponse(null, { status: 204 });
});
