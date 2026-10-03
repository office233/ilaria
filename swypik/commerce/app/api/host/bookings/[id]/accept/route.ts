/**
 * POST /api/host/bookings/[id]/accept — gazda acceptă o cerere plătită:
 * cardul e capturat (sau banii din wallet rămân încasați), rezervarea devine
 * 'confirmed', netul gazdei intră în wallet.
 */
import { NextResponse } from "next/server";
import { acceptBooking } from "@/lib/stays/host-decisions";
import { requireHost } from "@/lib/stays/hosts";
import { idParam, limitOrThrow, requireSession, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = staysRoute("host/bookings/accept", async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession();
    await limitOrThrow(req, "host-decision", session.userId, { limit: 60, window: 3600 });
    await requireHost(session.userId);
    const id = await idParam(ctx.params);
    return NextResponse.json({ ok: true, ...(await acceptBooking(id, session.userId)) });
});
