/**
 * Dispatch Engine — motorul generic de atribuire curieri (delivery + ride).
 *
 * Concepte:
 *  - dispatch_jobs: un job per comandă/cursă în căutare de curier.
 *  - Valuri (waves): raza de căutare crește 2 km → 5 km → 10 km.
 *    Fiecare val emite oferte (dispatch_offers) către max 5 curieri
 *    ordonați după distanță (haversine în SQL). Oferta expiră în 45s.
 *  - După 3 valuri fără accept → status 'no_courier'.
 *  - tick(): rulat de worker la ~10s — pune offline curierii fără heartbeat,
 *    expiră ofertele, avansează valurile.
 *  - acceptOffer(): tranzacție cu SELECT ... FOR UPDATE — anti dublă-asignare.
 *
 * Evenimente publicate pe Redis (canal `dispatch:job:<id>`):
 *  { type: "status", status, courier_id? } | { type: "location", lat, lng }
 */
import { dbQuery, withTransaction } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { sendMobilityPush } from "./push-i18n";
import { documentsValidSql, requiredDocumentsFor } from "@/lib/fleet/documents";
import { logger } from "@/lib/logger";
import { OFFER_TTL_SECONDS, MAX_COURIERS_PER_WAVE, WAVE_RADII_KM } from "./constants";
import { COURIER_AVAILABLE_SQL, sweepStaleCouriers } from "./lifecycle";
import { cancelRideAuthorization } from "@/lib/payments/mobility-stripe";
import { shareExpirySql } from "@/lib/rides/share";

// Re-exportate din lib/dispatch/constants pentru compatibilitate cu importatorii actuali.
export { VEHICLE_SPEED_KMH } from "./constants";
export { OFFER_TTL_SECONDS, MAX_COURIERS_PER_WAVE, WAVE_RADII_KM };

export type DispatchKind = "delivery" | "ride";

export type DispatchJob = {
    id: string;
    kind: DispatchKind;
    order_id: string | null;
    ride_id: string | null;
    city: string;
    pickup_lat: number | null;
    pickup_lng: number | null;
    status: "searching" | "assigned" | "no_courier" | "cancelled" | "completed";
    wave: number;
    assigned_courier_id: string | null;
};

export type CreateJobInput = {
    kind: DispatchKind;
    orderId?: string;
    rideId?: string;
    city: string;
    pickupLat?: number | null;
    pickupLng?: number | null;
};

export type AcceptResult =
    | { ok: true; jobId: string; orderId: string | null; rideId: string | null }
    | { ok: false; error: string; code: number };

type CourierRow = {
    id: string;
    user_id: string | null;
    distance_km: number | null;
};

export async function publishJobEvent(
    jobId: string,
    event: Record<string, unknown>,
): Promise<void> {
    try {
        await getRedis().publish(`dispatch:job:${jobId}`, JSON.stringify(event));
    } catch (err) {
        logger.error({ err, jobId }, "[dispatch] publish failed");
    }
}

/**
 * Emite ofertele pentru valul curent al unui job: curieri online, aprobați,
 * din același oraș, în raza valului, care nu au primit deja oferta pentru
 * acest job, ordonați după distanță haversine.
 * Returnează numărul de oferte create.
 */
async function emitWaveOffers(job: DispatchJob): Promise<number> {
    const radiusKm = WAVE_RADII_KM[Math.min(job.wave, WAVE_RADII_KM.length - 1)];
    const hasCoords = job.pickup_lat != null && job.pickup_lng != null;
    const courierKind = job.kind === "ride" ? "driver" : "courier";
    // Documentele obligatorii aprobate și neexpirate (audit food-go #2).
    const requiredDocs = await requiredDocumentsFor(courierKind);

    const { rows: couriers } = await dbQuery<CourierRow>(
        `SELECT c.id, c.user_id,
            CASE WHEN $2::float8 IS NOT NULL AND c.current_lat IS NOT NULL THEN
              6371 * 2 * asin(sqrt(
                power(sin(radians((c.current_lat - $2) / 2)), 2) +
                cos(radians($2)) * cos(radians(c.current_lat)) *
                power(sin(radians((c.current_lng - $3) / 2)), 2)
              ))
            ELSE NULL END AS distance_km
       FROM couriers c
            -- unaccent: jobul vine cu orasul din pricing_zones (cu diacritice, ex. "București"),
            -- curierii isi scriu orasul liber (ex. "Bucuresti") -> fara unaccent nu se potrivesc niciodata.
            WHERE unaccent(lower(c.city)) = unaccent(lower($1))
        AND c.is_online
        -- suspendat (active=false) sau fără heartbeat recent → fără oferte
        AND ${COURIER_AVAILABLE_SQL}
        AND c.verification_status = 'approved'
        AND c.kind = $7
        AND c.deleted_at IS NULL
        AND ${documentsValidSql("$8")}
        AND c.id NOT IN (SELECT courier_id FROM dispatch_offers WHERE job_id = $4)
        AND c.id NOT IN (
          SELECT assigned_courier_id FROM dispatch_jobs
           WHERE status = 'assigned' AND assigned_courier_id IS NOT NULL
        )
        AND c.id NOT IN (
          SELECT courier_id FROM local_orders
           WHERE courier_id IS NOT NULL AND status IN ('picked_up','delivering')
        )
        AND ($2::float8 IS NULL OR c.current_lat IS NULL OR
             6371 * 2 * asin(sqrt(
               power(sin(radians((c.current_lat - $2) / 2)), 2) +
               cos(radians($2)) * cos(radians(c.current_lat)) *
               power(sin(radians((c.current_lng - $3) / 2)), 2)
             )) <= $5)
      ORDER BY distance_km ASC NULLS LAST
      LIMIT $6`,
        [
            job.city,
            hasCoords ? job.pickup_lat : null,
            hasCoords ? job.pickup_lng : null,
            job.id,
            radiusKm,
            MAX_COURIERS_PER_WAVE,
            courierKind,
            requiredDocs,
        ],
    );

    if (!couriers.length) return 0;

    for (const c of couriers) {
        await dbQuery(
            `INSERT INTO dispatch_offers (job_id, order_id, courier_id, expires_at, wave)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5)
       ON CONFLICT DO NOTHING`,
            [job.id, job.order_id, c.id, OFFER_TTL_SECONDS, job.wave],
        );
        if (c.user_id) {
            // Push best-effort; nu blocăm dispatch-ul.
            void sendMobilityPush(c.user_id, job.kind === "ride" ? "newRide" : "newDelivery", {
                url: "/courier",
                tag: `dispatch-offer-${job.id}`,
            });
        }
    }
    return couriers.length;
}

/**
 * Creează (idempotent) un job de dispatch și emite primul val de oferte.
 * Dacă există deja un job activ pentru comandă/cursă, îl returnează.
 */
export async function createJob(
    input: CreateJobInput,
): Promise<{ job: DispatchJob; offered: number }> {
    const { rows: existing } = await dbQuery<DispatchJob>(
        `SELECT * FROM dispatch_jobs
      WHERE status IN ('searching','assigned')
        AND ((($1::uuid IS NOT NULL) AND order_id = $1) OR (($2::uuid IS NOT NULL) AND ride_id = $2))
      LIMIT 1`,
        [input.orderId ?? null, input.rideId ?? null],
    );
    if (existing[0]) return { job: existing[0], offered: 0 };

    const { rows } = await dbQuery<DispatchJob>(
        `INSERT INTO dispatch_jobs (kind, order_id, ride_id, city, pickup_lat, pickup_lng)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
        [
            input.kind,
            input.orderId ?? null,
            input.rideId ?? null,
            input.city,
            input.pickupLat ?? null,
            input.pickupLng ?? null,
        ],
    );
    const job = rows[0];

    if (job.order_id) {
        await dbQuery(
            `UPDATE local_orders SET dispatch_status = 'offered', updated_at = now() WHERE id = $1`,
            [job.order_id],
        );
    }

    const offered = await emitWaveOffers(job);
    if (!offered) {
        // Niciun curier în primul val — worker-ul va avansa valurile la tick.
        logger.info({ jobId: job.id }, "[dispatch] no couriers in wave 0");
    }
    await publishJobEvent(job.id, { type: "status", status: "searching", wave: job.wave });
    return { job, offered };
}

/**
 * Acceptă o ofertă — tranzacție cu FOR UPDATE pe job (și pe comandă) astfel
 * încât doi curieri nu pot fi asignați simultan pe același job.
 */
export async function acceptOffer(jobOrOrderId: string, courierId: string): Promise<AcceptResult> {
    const result = await withTransaction<AcceptResult>(async (q) => {
        // Ordinea lock-urilor: întâi rândul părinte (cursa / comanda), apoi jobul —
        // aceeași ordine ca în cancelRide / transitionOrder (ride → job, order → job).
        // Invers (job → ride) două tranzacții concurente se blocau reciproc (audit #12).
        const { rows: peek } = await q<{ ride_id: string | null; order_id: string | null }>(
            `SELECT ride_id, order_id FROM dispatch_jobs
        WHERE (id = $1 OR order_id = $1) AND status IN ('searching','assigned')
        ORDER BY created_at DESC LIMIT 1`,
            [jobOrOrderId],
        );
        if (peek[0]?.ride_id) {
            await q(`SELECT id FROM rides WHERE id = $1 FOR UPDATE`, [peek[0].ride_id]);
        } else if (peek[0]?.order_id) {
            await q(`SELECT id FROM local_orders WHERE id = $1 FOR UPDATE`, [peek[0].order_id]);
        }

        const { rows: jobs } = await q<DispatchJob>(
            `SELECT * FROM dispatch_jobs
        WHERE (id = $1 OR order_id = $1) AND status IN ('searching','assigned')
        FOR UPDATE`,
            [jobOrOrderId],
        );
        const job = jobs[0];
        if (!job) return { ok: false as const, error: "Dispatch job not found.", code: 404 };
        if (job.status === "assigned" || job.assigned_courier_id) {
            return { ok: false as const, error: "Job already taken.", code: 409 };
        }

        const { rows: offer } = await q(
            `SELECT id FROM dispatch_offers
        WHERE job_id = $1 AND courier_id = $2 AND response IS NULL AND expires_at > now()
        FOR UPDATE`,
            [job.id, courierId],
        );
        if (!offer.length) {
            return { ok: false as const, error: "Offer expired.", code: 410 };
        }

        // Curierul nu poate avea două joburi active simultan. Lock pe rândul
        // curierului serializează accept-urile concurente ale aceluiași curier.
        const { rows: courierRows } = await q<{ active: boolean }>(
            `SELECT active FROM couriers WHERE id = $1 FOR UPDATE`,
            [courierId],
        );
        // Curier suspendat: nu poate accepta (audit P0 — suspendarea nu avea efect).
        if (!courierRows[0]?.active) {
            return { ok: false as const, error: "Courier account suspended.", code: 403 };
        }
        const { rows: busy } = await q(
            `SELECT id FROM dispatch_jobs
        WHERE assigned_courier_id = $1 AND status = 'assigned'`,
            [courierId],
        );
        if (busy.length) {
            return { ok: false as const, error: "You already have an active job.", code: 409 };
        }

        await q(
            `UPDATE dispatch_offers SET response = 'accepted', responded_at = now() WHERE id = $1`,
            [offer[0].id],
        );
        await q(
            `UPDATE dispatch_offers SET response = 'expired', responded_at = now()
        WHERE job_id = $1 AND response IS NULL`,
            [job.id],
        );
        await q(
            `UPDATE dispatch_jobs
          SET status = 'assigned', assigned_courier_id = $2, assigned_at = now(), updated_at = now()
        WHERE id = $1`,
            [job.id, courierId],
        );

        if (job.order_id) {
            const { rows: locked } = await q(
                `SELECT id, courier_id FROM local_orders WHERE id = $1 FOR UPDATE`,
                [job.order_id],
            );
            if (locked[0]?.courier_id) {
                // Comandă deja asignată în afara engine-ului — abort.
                throw new Error("order_already_assigned");
            }
            await q(
                `UPDATE local_orders
            SET courier_id = $2, dispatch_status = 'assigned', updated_at = now()
          WHERE id = $1`,
                [job.order_id, courierId],
            );
        }
        if (job.ride_id) {
            const { rows: rideRows } = await q(
                `UPDATE rides SET driver_id = $2, status = 'accepted', job_id = COALESCE(job_id, $3)
                  WHERE id = $1 AND driver_id IS NULL AND status IN ('requested', 'searching')
                  RETURNING id`,
                [job.ride_id, courierId, job.id],
            );
            // Cursa a fost anulată între timp → nu atribuim (rollback).
            if (!rideRows.length) throw new Error("order_already_assigned");
        }

        return { ok: true as const, jobId: job.id, orderId: job.order_id, rideId: job.ride_id };
    }).catch((err: unknown) => {
        if (err instanceof Error && err.message === "order_already_assigned") {
            return { ok: false as const, error: "Job already taken.", code: 409 };
        }
        throw err;
    });

    if (result.ok) {
        await publishJobEvent(result.jobId, {
            type: "status",
            status: "assigned",
            courier_id: courierId,
        });
        // Push best-effort către rider: „Șofer găsit: {nume} • {mașină}".
        if (result.rideId) {
            void (async () => {
                const { rows } = await dbQuery<{
                    rider_user_id: string | null;
                    full_name: string;
                    vehicle_make: string | null;
                    vehicle_model: string | null;
                    vehicle_plate: string | null;
                }>(
                    `SELECT r.rider_user_id, c.full_name, c.vehicle_make, c.vehicle_model, c.vehicle_plate
             FROM rides r JOIN couriers c ON c.id = $2
            WHERE r.id = $1`,
                    [result.rideId, courierId],
                );
                const row = rows[0];
                if (!row?.rider_user_id) return;
                const car = [row.vehicle_make, row.vehicle_model].filter(Boolean).join(" ") || row.vehicle_plate || "";
                await sendMobilityPush(row.rider_user_id, "driverFound", {
                    url: `/go/${result.rideId}`,
                    vars: { name: row.full_name.split(" ")[0] ?? row.full_name, car },
                });
            })().catch(() => { /* best-effort */ });
        }
    }
    return result;
}

/** Refuză oferta curentă a curierului pentru un job/comandă. */
export async function declineOffer(jobOrOrderId: string, courierId: string): Promise<void> {
    await dbQuery(
        `UPDATE dispatch_offers o SET response = 'declined', responded_at = now()
      FROM dispatch_jobs j
     WHERE o.job_id = j.id AND (j.id = $1 OR j.order_id = $1)
       AND o.courier_id = $2 AND o.response IS NULL`,
        [jobOrOrderId, courierId],
    );
}

export type TickResult = {
    staleCouriers: number;
    expiredOffers: number;
    advancedWaves: number;
    noCourier: number;
};

/**
 * Tick-ul worker-ului (rulat la ~10s):
 *  1. marchează ofertele expirate (expires_at < now(), fără răspuns);
 *  2. joburile 'searching' fără oferte active: avansează valul (rază mai mare)
 *     sau declară 'no_courier' după epuizarea valurilor.
 */
export async function tick(): Promise<TickResult> {
    const result: TickResult = { staleCouriers: 0, expiredOffers: 0, advancedWaves: 0, noCourier: 0 };

    // 0. Curieri suspendați / fără heartbeat → offline (ofertele lor expiră).
    result.staleCouriers = await sweepStaleCouriers();

    const { rowCount: expired } = await dbQuery(
        `UPDATE dispatch_offers SET response = 'expired', responded_at = now()
      WHERE response IS NULL AND expires_at < now()`,
    );
    result.expiredOffers = expired;

    const { rows: stalled } = await dbQuery<DispatchJob>(
        `SELECT j.* FROM dispatch_jobs j
      WHERE j.status = 'searching'
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_offers o
           WHERE o.job_id = j.id AND o.response IS NULL AND o.expires_at > now()
        )
      ORDER BY j.created_at
      LIMIT 50`,
    );

    for (const job of stalled) {
        const nextWave = job.wave + 1;
        if (nextWave >= WAVE_RADII_KM.length) {
            await dbQuery(
                `UPDATE dispatch_jobs SET status = 'no_courier', updated_at = now() WHERE id = $1`,
                [job.id],
            );
            if (job.order_id) {
                await dbQuery(
                    `UPDATE local_orders SET dispatch_status = 'no_courier', updated_at = now() WHERE id = $1`,
                    [job.order_id],
                );
            }
            if (job.ride_id) {
                // Audit go.md §2.8: anularea „no driver" nu avea cancelled_at /
                // cancelled_by / expirarea share-link-ului, iar hold-ul pe card rămânea.
                await dbQuery(
                    `UPDATE rides
                        SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'system',
                            cancel_reason = 'no_driver', cancel_fee_cents = 0,
                            share_expires_at = ${shareExpirySql()}, updated_at = now()
                      WHERE id = $1 AND driver_id IS NULL AND status IN ('requested', 'searching')`,
                    [job.ride_id],
                );
                await cancelRideAuthorization(job.ride_id).catch((err) =>
                    logger.warn({ err, rideId: job.ride_id }, "[dispatch] release ride hold failed"),
                );
            }
            await publishJobEvent(job.id, { type: "status", status: "no_courier" });
            result.noCourier += 1;
            continue;
        }

        await dbQuery(`UPDATE dispatch_jobs SET wave = $2, updated_at = now() WHERE id = $1`, [
            job.id,
            nextWave,
        ]);
        const advanced: DispatchJob = { ...job, wave: nextWave };
        const offered = await emitWaveOffers(advanced);
        logger.info({ jobId: job.id, wave: nextWave, offered }, "[dispatch] wave advanced");
        await publishJobEvent(job.id, { type: "status", status: "searching", wave: nextWave });
        result.advancedWaves += 1;
    }

    return result;
}

/** Jobul activ al unei comenzi (dacă există). */
export async function getJobForOrder(orderId: string): Promise<DispatchJob | null> {
    const { rows } = await dbQuery<DispatchJob>(
        `SELECT * FROM dispatch_jobs WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [orderId],
    );
    return rows[0] ?? null;
}

/** Jobul activ al unei curse (dacă există). */
export async function getJobForRide(rideId: string): Promise<DispatchJob | null> {
    const { rows } = await dbQuery<DispatchJob>(
        `SELECT * FROM dispatch_jobs WHERE ride_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [rideId],
    );
    return rows[0] ?? null;
}
