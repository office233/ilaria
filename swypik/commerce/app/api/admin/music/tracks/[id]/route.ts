import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { updateTrack } from "@/lib/music/repository";
import { archiveTrack, publishTrack, updateTrackAndSync } from "@/lib/music/publish";
import { logAdminAction } from "@/lib/security/admin-audit";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({ action: z.enum(["approve", "reject", "publish", "archive"]) });

export const PATCH = withErrorHandling(async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!isEnabled("music")) return frozenResponse("music");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;
    const parsed = parseBody(PatchSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    switch (parsed.data.action) {
        case "approve": {
            const track = await updateTrack(id, null, { moderationStatus: "approved" });
            if (!track) return NextResponse.json({ error: "not_found" }, { status: 404 });
            await logAdminAction({ action: "music_track.approve", targetType: "music_track", targetId: id, req });
            return NextResponse.json({ track });
        }
        case "reject": {
            // O piesă publicată și respinsă ulterior iese din catalog și din sunetele pentru reels.
            const track = await updateTrackAndSync(id, null, { moderationStatus: "rejected", status: "draft" });
            if (!track) return NextResponse.json({ error: "not_found" }, { status: 404 });
            await logAdminAction({ action: "music_track.reject", targetType: "music_track", targetId: id, req });
            return NextResponse.json({ track });
        }
        case "publish": {
            const result = await publishTrack(id);
            if (!result.ok) {
                const status = result.reason === "not_approved" ? 409 : 404;
                return NextResponse.json({ error: result.reason }, { status });
            }
            await logAdminAction({ action: "music_track.publish", targetType: "music_track", targetId: id, req });
            return NextResponse.json({ track: result.track });
        }
        case "archive": {
            const track = await archiveTrack(id, null);
            if (!track) return NextResponse.json({ error: "not_found" }, { status: 404 });
            await logAdminAction({ action: "music_track.archive", targetType: "music_track", targetId: id, req });
            return NextResponse.json({ track });
        }
    }
});
