import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCreatorUserId } from "@/lib/creator/session";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { isArtist } from "@/lib/music/repository";
import { MUSIC_ALLOWED_MIME, MUSIC_MAX_UPLOAD_BYTES } from "@/lib/music/config";
import { createAudioUploadUrl } from "@/lib/storage/media-upload";

export const dynamic = "force-dynamic";

const UploadUrlSchema = z.object({
    filename: z.string().trim().min(1).max(200),
    contentType: z.string().trim().min(1).max(100),
    sizeBytes: z.coerce.number().int().positive(),
});

/** Cere un URL presemnat PUT pe R2 pentru fișierul audio brut al unei piese noi. */
export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("music")) return frozenResponse("music");
    const userId = await getCreatorUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!(await isArtist(userId))) return NextResponse.json({ error: "not_an_artist" }, { status: 403 });

    const rl = await rateLimit("musicPublish", userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const parsed = parseBody(UploadUrlSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    const { filename, contentType, sizeBytes } = parsed.data;

    if (!(MUSIC_ALLOWED_MIME as readonly string[]).includes(contentType)) {
        return NextResponse.json({ error: "unsupported_type" }, { status: 400 });
    }
    if (sizeBytes > MUSIC_MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: "file_too_large" }, { status: 400 });
    }

    const trackId = randomUUID();
    const upload = await createAudioUploadUrl({ artistUserId: userId, trackId, filename, contentType });
    return NextResponse.json({ trackId, url: upload.url, key: upload.key, expiresIn: upload.expiresIn });
});
