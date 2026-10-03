import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { listTracksForAdmin } from "@/lib/music/repository";

export const dynamic = "force-dynamic";

const StatusQuerySchema = z.object({
    status: z.enum(["draft", "pending_review", "published", "archived"]).optional(),
});

export const GET = withErrorHandling(async function GET(req: Request) {
    if (!isEnabled("music")) return frozenResponse("music");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const raw = new URL(req.url).searchParams.get("status");
    const parsed = parseBody(StatusQuerySchema, { status: raw ?? undefined });
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    return NextResponse.json({ tracks: await listTracksForAdmin(parsed.data.status) });
});
