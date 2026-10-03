import { NextResponse } from "next/server";
import { isNativeAppRequest, PURCHASE_UNAVAILABLE_IN_APP } from "@/lib/media/native-app";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { getAlbumBySlug } from "@/lib/music/repository";
import { createAlbumUnlockIntent } from "@/lib/music/unlock";

export const dynamic = "force-dynamic";

const FAILURE_STATUS = { not_found: 404, not_premium: 409, not_published: 404, price_not_set: 409 } as const;

export const POST = withErrorHandling(async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
    if (!isEnabled("music")) return frozenResponse("music");
    // Shell-ul nativ: deblocările digitale nu se vând în afara IAP (App Store 3.1.1 / Play Payments).
    if (isNativeAppRequest(req)) return NextResponse.json({ error: PURCHASE_UNAVAILABLE_IN_APP }, { status: 403 });
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    const rl = await rateLimit("musicUnlock", user.userId);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const { slug } = await params;
    const album = await getAlbumBySlug(slug);
    if (!album) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const result = await createAlbumUnlockIntent({ userId: user.userId, albumId: album.id });
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: FAILURE_STATUS[result.reason] });
    if (result.alreadyUnlocked) return NextResponse.json({ alreadyUnlocked: true });
    return NextResponse.json({ alreadyUnlocked: false, clientSecret: result.clientSecret, amountCents: result.amountCents });
});
