import { NextResponse } from "next/server";
import { constraintError } from "@/lib/movies/pg-errors";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { upsertProgress } from "@/lib/movies/repository";

export const dynamic = "force-dynamic";

const MAX_POSITION_MS = 24 * 3_600_000;

const BodySchema = z.object({
    episodeId: z.string().uuid(),
    positionMs: z.coerce.number().int().min(0).max(MAX_POSITION_MS),
    completed: z.boolean().default(false),
});

export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ ok: false, error: "auth_required" }, { status: 401 });
    const rl = await rateLimit("moviesProgress", user.userId);
    if (!rl.success) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
    try {
        await upsertProgress(user.userId, parsed.data.episodeId, parsed.data.positionMs, parsed.data.completed);
    } catch (err) {
        // Episod inexistent (FK) → 404, nu 500.
        const mapped = constraintError(err);
        if (mapped) return NextResponse.json({ ok: false, error: mapped.error }, { status: mapped.status });
        throw err;
    }
    return NextResponse.json({ ok: true });
});
