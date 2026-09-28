import { NextResponse } from "next/server";
import { AudioSearchQuerySchema } from "@/lib/audio/query-schemas";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { searchRadioStations } from "@/lib/audio/radio-browser";
import { searchAudiusTracks } from "@/lib/audio/audius";
import { searchJamendoTracks } from "@/lib/audio/jamendo";
import { fetchPodcastEpisodes } from "@/lib/audio/podcast";
import type { AudioItemDto } from "@/lib/audio/types";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(req: Request) {
    if (!isEnabled("music")) return frozenResponse("music");
    const rl = await rateLimit("musicCatalog", getClientIP(req));
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = AudioSearchQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) return NextResponse.json({ error: "invalid_query", items: [] }, { status: 400 });
    const { q: query, source } = parsed.data;

    if (!query) {
        return applyCachePolicy(NextResponse.json({ items: [] }), "audio/search", req);
    }

    const tasks: Promise<AudioItemDto[]>[] = [];

    if (source === "radio" || source === "all") {
        tasks.push(searchRadioStations(query, 10));
    }
    if (source === "audius" || source === "all") {
        tasks.push(searchAudiusTracks(query, 10));
    }
    if (source === "jamendo" || source === "all") {
        tasks.push(searchJamendoTracks(query, 10));
    }
    if (source === "podcast" || source === "all") {
        tasks.push(fetchPodcastEpisodes(query, "ro", 6));
    }

    const settled = await Promise.allSettled(tasks);
    const results: AudioItemDto[] = [];

    for (const res of settled) {
        if (res.status === "fulfilled" && Array.isArray(res.value)) {
            results.push(...res.value);
        }
    }

    return applyCachePolicy(NextResponse.json({ items: results }), "audio/search", req);
});
