/**
 * GET /api/stays/bookings/[id] — detaliul unei rezervări, pentru client sau
 * gazdă (doar părțile rezervării). Include previzualizarea refundului.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import type { Q } from "@/lib/stays/booking";
import { loadBooking, relationTo } from "@/lib/stays/bookings-repo";
import { previewGuestRefund } from "@/lib/stays/cancellation";
import { staysError } from "@/lib/stays/errors";
import { idParam, requireSession, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const db: Q = (text, params) => dbQuery(text, params ?? []);

export const GET = staysRoute("stays/bookings/[id]", async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireSession();
    const id = await idParam(ctx.params);
    const b = await loadBooking(db, id);
    const rel = b ? relationTo(b, session.userId) : null;
    if (!b || !rel) return staysError("not_found");
    const { stripe_payment_intent_id: _pi, ...pub } = b;
    return NextResponse.json({ booking: pub, role: rel, refundPreview: previewGuestRefund(b) });
});
