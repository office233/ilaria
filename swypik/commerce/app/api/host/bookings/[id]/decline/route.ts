/**
 * POST /api/host/bookings/[id]/decline { reason? } — gazda refuză o cerere:
 * hold-ul pe card e anulat (sau suma din wallet se întoarce), clientul e anunțat.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { staysError } from "@/lib/stays/errors";
import { declineBooking } from "@/lib/stays/host-decisions";
import { requireHost } from "@/lib/stays/hosts";
import { idParam, limitOrThrow, requireSession, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ reason: z.string().trim().max(500).optional() });

export const POST = staysRoute("host/bookings/decline", async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession();
    await limitOrThrow(req, "host-decision", session.userId, { limit: 60, window: 3600 });
    await requireHost(session.userId);
    const id = await idParam(ctx.params);
    const parsed = schema.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) return staysError("invalid_input");
    return NextResponse.json({ ok: true, ...(await declineBooking(id, session.userId, parsed.data.reason || null)) });
});
