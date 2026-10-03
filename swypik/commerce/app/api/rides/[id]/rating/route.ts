/**
 * POST /api/rides/[id]/rating — rating bidirecțional după 'completed'.
 * rider → notează șoferul (actualizează couriers.rating ca medie),
 * driver → notează riderul. Un singur rating per rol per cursă.
 */
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { loadRide, resolveRole } from "@/lib/rides/service";
import { RideRatingSchema } from "@/lib/validation/rides";
import { parseBody } from "@/lib/validation/schemas";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withErrorHandling(async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const session = await getAuthSession();
  if (!session?.userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const rl = await rateLimit("rideAction", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const body = await req.json().catch(() => null);
  const parsed = parseBody(RideRatingSchema, body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const ride = await loadRide(id);
  if (!ride) return NextResponse.json({ error: "Ride not found." }, { status: 404 });
  if (ride.status !== "completed") {
    return NextResponse.json({ error: "Only completed rides can be rated." }, { status: 409 });
  }

  const authUser = await getAuthUser().catch(() => null);
  const role = await resolveRole(ride, session.userId, Boolean(authUser?.isAdmin));
  if (role !== "rider" && role !== "driver") {
    return NextResponse.json({ error: "Only the rider or driver can rate." }, { status: 403 });
  }

  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO ride_ratings (ride_id, rater_role, stars, comment)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ride_id, rater_role) DO NOTHING
     RETURNING id`,
    [id, role, parsed.data.stars, parsed.data.comment ?? null],
  );
  if (!rows.length) {
    return NextResponse.json({ error: "You already rated this ride." }, { status: 409 });
  }

  // rider → recalculează media șoferului din TOATE ratingurile de tip rider.
  if (role === "rider" && ride.driver_id) {
    await dbQuery(
      `UPDATE couriers c
          SET rating = sub.avg_stars, updated_at = now()
         FROM (SELECT AVG(rr.stars)::numeric(3,2) AS avg_stars
                 FROM ride_ratings rr
                 JOIN rides r ON r.id = rr.ride_id
                WHERE r.driver_id = $1 AND rr.rater_role = 'rider') sub
        WHERE c.id = $1`,
      [ride.driver_id],
    );
  }

  return NextResponse.json({ ok: true }, { status: 201 });
});
