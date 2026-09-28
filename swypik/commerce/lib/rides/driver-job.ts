/**
 * Jobul activ al unui șofer/curier — sursa de adevăr pentru panoul șoferului
 * după reload (audit P1: jobul trăia doar în React state).
 *
 *  - cursă Go: accepted | arriving | in_progress, sau 'completed' cash încă
 *    neîncasat (șoferul trebuie să confirme suma de încasat);
 *  - livrare Food: comandă atribuită, încă nelivrată.
 */
import { dbQuery } from "@/lib/db";
import { cashToCollectCents } from "./policy";

export type DriverProfile = {
  id: string;
  user_id: string;
  kind: "courier" | "driver";
  full_name: string;
  city: string;
  verification_status: string;
  active: boolean;
  is_online: boolean;
  rating: string | null;
  vehicle_plate: string | null;
};

export async function getCourierForUser(userId: string): Promise<DriverProfile | null> {
  const { rows } = await dbQuery<DriverProfile>(
    `SELECT id, user_id, kind, full_name, city, verification_status, active, is_online, rating, vehicle_plate
       FROM couriers WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

export type ActiveRideJob = {
  kind: "ride";
  ride_id: string;
  status: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  vehicle_class: string;
  payment_method: string;
  payment_status: string;
  estimated_fare_cents: number | null;
  final_fare_cents: number | null;
  currency: string;
  rider_first_name: string | null;
  rider_rated: boolean;
  cash_to_collect_cents: number;
  accepted_at: string | null;
};

export type ActiveDeliveryJob = {
  kind: "delivery";
  order_id: string;
  order_number: string;
  status: string;
  merchant_name: string;
  pickup_address: string | null;
  delivery_address: string;
  customer_first_name: string | null;
  payment_method: string;
  cash_to_collect_cents: number;
  currency: string;
  /** Navigare + contact în panoul curierului (audit food-go #19). */
  pickup_lat: number | null;
  pickup_lng: number | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  merchant_phone: string | null;
  customer_phone: string | null;
};

export type ActiveJob = ActiveRideJob | ActiveDeliveryJob;

type RideJobRow = Omit<ActiveRideJob, "kind" | "cash_to_collect_cents"> & { tip_cents: number };

async function activeRide(courierId: string): Promise<ActiveRideJob | null> {
  const { rows } = await dbQuery<RideJobRow>(
    `SELECT r.id AS ride_id, r.status, r.pickup_address, r.pickup_lat, r.pickup_lng,
            r.dropoff_address, r.dropoff_lat, r.dropoff_lng, r.vehicle_class,
            r.payment_method, r.payment_status, r.estimated_fare_cents, r.final_fare_cents,
            trim(r.currency) AS currency, COALESCE(r.tip_cents, 0)::int AS tip_cents, r.accepted_at,
            NULLIF(split_part(COALESCE(u.display_name, u.username, ''), ' ', 1), '') AS rider_first_name,
            EXISTS (SELECT 1 FROM ride_ratings rr WHERE rr.ride_id = r.id AND rr.rater_role = 'driver') AS rider_rated
       FROM rides r
       LEFT JOIN users u ON u.id = r.rider_user_id
      WHERE r.driver_id = $1
        AND (r.status IN ('accepted', 'arriving', 'in_progress')
             OR (r.status = 'completed' AND r.payment_method = 'cash' AND r.payment_status = 'unpaid'
                 AND r.completed_at > now() - interval '12 hours'))
      ORDER BY (r.status = 'completed') ASC, r.requested_at DESC
      LIMIT 1`,
    [courierId],
  );
  const r = rows[0];
  if (!r) return null;
  const { tip_cents, ...rest } = r;
  return { kind: "ride", ...rest, cash_to_collect_cents: cashToCollectCents({ ...r, tip_cents }) };
}

async function activeDelivery(courierId: string): Promise<ActiveDeliveryJob | null> {
  const { rows } = await dbQuery<Omit<ActiveDeliveryJob, "kind" | "cash_to_collect_cents"> & { total_cents: number }>(
    `SELECT lo.id AS order_id, lo.order_number, lo.status, m.name AS merchant_name, m.address AS pickup_address,
            lo.delivery_address, NULLIF(split_part(lo.customer_name, ' ', 1), '') AS customer_first_name,
            lo.payment_method, lo.total_cents, trim(lo.currency) AS currency,
            m.location_lat AS pickup_lat, m.location_lng AS pickup_lng,
            lo.delivery_lat, lo.delivery_lng, m.phone AS merchant_phone, lo.customer_phone
       FROM local_orders lo
       JOIN local_merchants m ON m.id = lo.merchant_id
      WHERE lo.courier_id = $1 AND lo.status IN ('accepted', 'preparing', 'ready', 'picked_up', 'delivering')
      ORDER BY lo.created_at DESC
      LIMIT 1`,
    [courierId],
  );
  const o = rows[0];
  if (!o) return null;
  const { total_cents, ...rest } = o;
  return { kind: "delivery", ...rest, cash_to_collect_cents: o.payment_method === "cash" ? total_cents : 0 };
}

export async function getDriverActiveJob(courier: Pick<DriverProfile, "id" | "kind">): Promise<ActiveJob | null> {
  return courier.kind === "driver" ? activeRide(courier.id) : activeDelivery(courier.id);
}

/**
 * Ultima cursă finalizată pe care șoferul nu a notat-o încă (card SAU cash deja
 * încasat), din ultima oră — audit food-go #18: înainte ratingul era posibil doar
 * pe cash, înainte de „am încasat". Nu blochează ofertele noi (nu e job activ).
 */
export type RideToRate = { ride_id: string; rider_first_name: string | null; completed_at: string };

export async function getRideToRate(courierId: string): Promise<RideToRate | null> {
  const { rows } = await dbQuery<RideToRate>(
    `SELECT r.id AS ride_id, r.completed_at::text AS completed_at,
            NULLIF(split_part(COALESCE(u.display_name, u.username, ''), ' ', 1), '') AS rider_first_name
       FROM rides r
       LEFT JOIN users u ON u.id = r.rider_user_id
      WHERE r.driver_id = $1 AND r.status = 'completed'
        AND r.completed_at > now() - interval '1 hour'
        AND NOT (r.payment_method = 'cash' AND r.payment_status = 'unpaid')
        AND NOT EXISTS (SELECT 1 FROM ride_ratings rr WHERE rr.ride_id = r.id AND rr.rater_role = 'driver')
      ORDER BY r.completed_at DESC
      LIMIT 1`,
    [courierId],
  );
  return rows[0] ?? null;
}

export type DriverDocument = { doc_type: string; status: string; expires_at: string | null };

export async function getDriverDocuments(courierId: string): Promise<DriverDocument[]> {
  try {
    const { rows } = await dbQuery<DriverDocument>(
      `SELECT doc_type, status, expires_at::text FROM courier_documents WHERE courier_id = $1 ORDER BY doc_type`,
      [courierId],
    );
    return rows;
  } catch {
    return []; // migrarea 20260926_0073 neaplicată încă
  }
}
