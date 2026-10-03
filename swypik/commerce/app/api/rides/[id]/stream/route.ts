/**
 * GET /api/rides/[id]/stream — SSE pentru o cursă: status + poziție șofer.
 *
 * Reutilizează canalul Redis al jobului de dispatch (`dispatch:job:<jobId>`,
 * engine R2) — nu duplicăm infrastructura de pub/sub. Peste evenimentele
 * jobului, trimitem un snapshot inițial cu starea cursei + poziția șoferului.
 *
 * Cursă cu cardul (audit food-go #1): stream-ul se deschide înainte ca jobul de
 * dispatch să existe (job_id NULL, deci niciun canal). Cât timp jobul lipsește,
 * verificăm periodic și, când apare, trimitem `{type:"resubscribe"}` — clientul
 * redeschide stream-ul pe canalul jobului. Clientul face oricum și polling.
 * Poziția șoferului se trimite doar cât cursa e activă (audit #9).
 */
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { createSseResponse } from "@/lib/realtime/sse";
import { realtimeChannels } from "@/lib/realtime";
import { loadRide, resolveRole } from "@/lib/rides/service";
import { isUuidParam } from "@/lib/validation/params";

const ACTIVE = new Set(["accepted", "arriving", "in_progress"]);
const JOB_WAIT_POLL_MS = 3_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuidParam(id)) {
    return new Response("Bad Request", { status: 400 });
  }

  const session = await getAuthSession();
  if (!session?.userId) return new Response("Unauthorized", { status: 401 });

  const ride = await loadRide(id);
  if (!ride) return new Response("Not Found", { status: 404 });

  const authUser = await getAuthUser().catch(() => null);
  const role = await resolveRole(ride, session.userId, Boolean(authUser?.isAdmin));
  if (!role) return new Response("Forbidden", { status: 403 });

  let announced = false;
  return createSseResponse({
    logTag: "rides/stream",
    channels: ride.job_id ? [realtimeChannels.dispatchJob(ride.job_id)] : [],
    signal: req.signal,
    poll: ride.job_id
      ? undefined
      : {
          intervalMs: JOB_WAIT_POLL_MS,
          run: async (send) => {
            if (announced) return;
            const fresh = await loadRide(id);
            if (fresh?.job_id || (fresh && fresh.status !== "requested")) {
              announced = true;
              send({ type: "resubscribe", status: fresh.status });
            }
          },
        },
    // Snapshot inițial: status cursă + poziția curentă a șoferului (din DB —
    // sursa de adevăr, deci corect indiferent pe ce replică se reconectează clientul).
    onOpen: async (send) => {
      const fresh = await loadRide(id);
      let driverPos: { lat: number | null; lng: number | null } | null = null;
      if (fresh?.driver_id && ACTIVE.has(fresh.status)) {
        const { rows } = await dbQuery<{ current_lat: number | null; current_lng: number | null }>(
          `SELECT current_lat, current_lng FROM couriers WHERE id = $1`,
          [fresh.driver_id],
        );
        if (rows[0]?.current_lat != null) {
          driverPos = { lat: rows[0].current_lat, lng: rows[0].current_lng };
        }
      }
      send({ type: "snapshot", status: fresh?.status, driver_id: fresh?.driver_id, driver_position: driverPos });
    },
  });
}
