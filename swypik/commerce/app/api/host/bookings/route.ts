/**
 * GET /api/host/bookings — rezervările primite de gazda curentă; cererile
 * care așteaptă acceptul ('requested') vin primele. Include contactul
 * clientului (gazda trebuie să-l poată contacta).
 */
import { NextResponse } from "next/server";
import { listHostBookings } from "@/lib/stays/bookings-repo";
import { requireSession, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = staysRoute("host/bookings", async () => {
    const session = await requireSession();
    const rows = await listHostBookings(session.userId);
    return NextResponse.json({
        bookings: rows.map(({ stripe_payment_intent_id: _pi, ...b }) => b),
    });
});
