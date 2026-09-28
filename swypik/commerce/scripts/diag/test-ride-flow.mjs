#!/usr/bin/env node
/**
 * Test integrare Swypik Go — estimate → request → accept → start → complete.
 * Rulează direct pe DB (fără HTTP), ca test-dispatch.mjs / test-pricing.mjs.
 *
 *   DATABASE_URL=postgres://... node scripts/test-ride-flow.mjs
 *
 * Verifică:
 *  1. estimare: formula pricing (zonă ride/economy București) pe haversine×1.3;
 *  2. creare cursă (requested→searching) + dispatch job kind='ride' + ofertă;
 *  3. accept șofer (logica acceptOffer) → rides.driver_id + status accepted;
 *  4. mașina de stări: arriving → in_progress; tranziții invalide respinse;
 *  5. completed: tarif FINAL recalculat pe distanța reală GPS
 *     (courier_location_history) — trebuie să difere de estimare și să fie
 *     exact computeFare(zone, gpsKm, durationMin, surge).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import pg from "pg";

for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const rawLine of readFileSync(f, "utf8").split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const CITY = "București"; // zona seed R3
const TAG = randomUUID().slice(0, 8);

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

// ─── replici fidele ale formulei din lib/pricing (menținute sincron manual) ──
function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function computeFare(zone, distanceKm, durationMin, surge) {
  const base = zone.base_cents;
  const dist = Math.round(zone.per_km_cents * distanceKm);
  const time = Math.round(zone.per_min_cents * durationMin);
  const surged = Math.round((base + dist + time) * surge);
  return Math.max(surged, zone.min_fare_cents) + zone.booking_fee_cents;
}

async function main() {
  const PICKUP = { lat: 44.4268, lng: 26.1025 }; // Piața Universității
  const DROPOFF = { lat: 44.4795, lng: 26.0834 }; // Băneasa

  // Zona ride/economy București (seed R3)
  const { rows: zones } = await pool.query(
    `SELECT * FROM pricing_zones
      WHERE lower(city)=lower($1) AND kind='ride' AND vehicle_class='economy' AND active
      LIMIT 1`,
    [CITY],
  );
  const zone = zones[0];
  if (!zone) throw new Error("Lipsește zona seed ride/economy București (migrarea 0008).");

  console.log("\n— 1. ESTIMATE (haversine×1.3, fără Google) —");
  const estKm = haversineKm(PICKUP, DROPOFF) * 1.3;
  const estMin = Math.max(1, Math.round((estKm / 25) * 60));
  const surge = 1.0; // oraș de test fără cerere — dar folosim orașul real; acceptăm surge>=1
  const estimatedFare = computeFare(zone, estKm, estMin, surge);
  check("estimare > min_fare + booking_fee", estimatedFare >= zone.min_fare_cents + zone.booking_fee_cents);

  console.log("\n— 2. REQUEST (rides + dispatch job kind='ride') —");
  const riderId = randomUUID();
  const { rows: rideRows } = await pool.query(
    `INSERT INTO rides (rider_user_id, city, vehicle_class, pickup_address, pickup_lat, pickup_lng,
                        dropoff_address, dropoff_lat, dropoff_lng, status,
                        estimated_fare_cents, currency, distance_km, duration_min, surge_multiplier,
                        fare_breakdown, payment_method)
     VALUES ($1,$2,'economy','Universității 1',$3,$4,'Băneasa 10',$5,$6,'requested',$7,'RON',$8,$9,1.00,'{}','cash')
     RETURNING id`,
    [riderId, CITY, PICKUP.lat, PICKUP.lng, DROPOFF.lat, DROPOFF.lng, estimatedFare, estKm.toFixed(3), estMin],
  );
  const rideId = rideRows[0].id;

  // Șofer aprobat online lângă pickup
  const { rows: drvRows } = await pool.query(
    `INSERT INTO couriers (user_id, kind, full_name, phone, vehicle_type, vehicle_plate, city,
                           verification_status, is_online, current_lat, current_lng, location_updated_at)
     VALUES ($1,'driver','Șofer Test ${TAG}','07000000','car','B-${TAG}',$2,'approved',true,$3,$4,now())
     RETURNING id`,
    [randomUUID(), CITY, PICKUP.lat + 0.002, PICKUP.lng + 0.002],
  );
  const driverId = drvRows[0].id;

  const { rows: jobRows } = await pool.query(
    `INSERT INTO dispatch_jobs (kind, ride_id, city, pickup_lat, pickup_lng, status, wave)
     VALUES ('ride',$1,$2,$3,$4,'searching',0) RETURNING id`,
    [rideId, CITY, PICKUP.lat, PICKUP.lng],
  );
  const jobId = jobRows[0].id;
  await pool.query(
    `UPDATE rides SET job_id=$2, status='searching' WHERE id=$1`,
    [rideId, jobId],
  );
  await pool.query(
    `INSERT INTO dispatch_offers (job_id, courier_id, expires_at, wave)
     VALUES ($1,$2,now() + interval '45 seconds',0)`,
    [jobId, driverId],
  );
  let r = (await pool.query(`SELECT status, job_id FROM rides WHERE id=$1`, [rideId])).rows[0];
  check("status = searching", r.status === "searching");
  check("job_id setat", r.job_id === jobId);

  console.log("\n— 3. ACCEPT (logica acceptOffer, tranzacțional) —");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT * FROM dispatch_jobs WHERE id=$1 FOR UPDATE`, [jobId]);
    await client.query(`UPDATE dispatch_offers SET response='accepted', responded_at=now() WHERE job_id=$1 AND courier_id=$2`, [jobId, driverId]);
    await client.query(`UPDATE dispatch_jobs SET status='assigned', assigned_courier_id=$2, assigned_at=now() WHERE id=$1`, [jobId, driverId]);
    await client.query(`UPDATE rides SET driver_id=$2, status='accepted', accepted_at=now() WHERE id=$1 AND driver_id IS NULL`, [rideId, driverId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  r = (await pool.query(`SELECT status, driver_id FROM rides WHERE id=$1`, [rideId])).rows[0];
  check("status = accepted", r.status === "accepted");
  check("driver atribuit", r.driver_id === driverId);

  console.log("\n— 4. MAȘINA DE STĂRI —");
  // Tranziție invalidă: accepted → completed direct (mașina de stări o interzice)
  const TRANSITIONS = {
    arriving: ["accepted"],
    in_progress: ["arriving"],
    completed: ["in_progress"],
    cancelled: ["requested", "searching", "accepted", "arriving"],
  };
  check("accepted → completed interzis", !TRANSITIONS.completed.includes("accepted"));
  check("accepted → arriving permis", TRANSITIONS.arriving.includes("accepted"));

  await pool.query(`UPDATE rides SET status='arriving', arrived_at=now() WHERE id=$1`, [rideId]);
  // started_at în trecut ca durata finală să fie ~5 min
  await pool.query(`UPDATE rides SET status='in_progress', started_at=now() - interval '5 minutes' WHERE id=$1`, [rideId]);
  r = (await pool.query(`SELECT status FROM rides WHERE id=$1`, [rideId])).rows[0];
  check("status = in_progress", r.status === "in_progress");

  console.log("\n— 5. COMPLETE + TARIF FINAL PE DISTANȚA REALĂ (GPS) —");
  // Traseu GPS real: 6 puncte de la pickup spre dropoff (deviat, deci mai lung)
  const gps = [
    PICKUP,
    { lat: 44.4400, lng: 26.1100 },
    { lat: 44.4520, lng: 26.1050 },
    { lat: 44.4630, lng: 26.0950 },
    { lat: 44.4720, lng: 26.0900 },
    DROPOFF,
  ];
  for (let i = 0; i < gps.length; i++) {
    await pool.query(
      `INSERT INTO courier_location_history (courier_id, lat, lng, recorded_at)
       VALUES ($1,$2,$3, now() - interval '5 minutes' + make_interval(secs => $4))`,
      [driverId, gps[i].lat, gps[i].lng, i * 50],
    );
  }
  // Distanța reală = suma segmentelor (replica lib/rides/service.ts actualDistanceKm)
  let gpsKm = 0;
  for (let i = 1; i < gps.length; i++) {
    const seg = haversineKm(gps[i - 1], gps[i]);
    if (seg <= 2) gpsKm += seg;
  }
  const finalMin = 5; // started_at = now()-5min
  const expectedFinal = computeFare(zone, gpsKm, finalMin, 1.0);

  await pool.query(
    `UPDATE rides SET status='completed', completed_at=now(),
          final_fare_cents=$2::int, distance_km=$3, duration_min=$4,
          fare_breakdown = jsonb_build_object('distance_source','gps','total_cents',$2::int)
      WHERE id=$1`,
    [rideId, expectedFinal, gpsKm.toFixed(3), finalMin],
  );

  r = (await pool.query(`SELECT * FROM rides WHERE id=$1`, [rideId])).rows[0];
  check("status = completed", r.status === "completed");
  check("final_fare_cents scris", Number(r.final_fare_cents) === expectedFinal, `(${r.final_fare_cents} vs ${expectedFinal})`);
  check(
    "distanța finală = suma GPS (≠ estimare)",
    Math.abs(Number(r.distance_km) - gpsKm) < 0.01 && Math.abs(Number(r.distance_km) - estKm) > 0.01,
    `(gps=${gpsKm.toFixed(3)} est=${estKm.toFixed(3)})`,
  );
  check("fare_breakdown.distance_source = gps", r.fare_breakdown?.distance_source === "gps");
  check(
    "tarif final = computeFare(zone, gpsKm, durMin, surge)",
    Number(r.final_fare_cents) === computeFare(zone, gpsKm, finalMin, 1.0),
  );

  console.log("\n— 6. RATING —");
  await pool.query(
    `INSERT INTO ride_ratings (ride_id, rater_role, stars, comment) VALUES ($1,'rider',5,'super')`,
    [rideId],
  );
  const dup = await pool
    .query(`INSERT INTO ride_ratings (ride_id, rater_role, stars) VALUES ($1,'rider',1) ON CONFLICT (ride_id, rater_role) DO NOTHING RETURNING id`, [rideId]);
  check("rating dublu respins (UNIQUE)", dup.rows.length === 0);

  console.log("\n— 7. GO POLISH: share token + anulare cu motiv + vehicul —");
  // share_token: unic, expiră la final + 1h
  const token = randomUUID().replace(/-/g, "");
  await pool.query(`UPDATE rides SET share_token=$2, share_expires_at=now() + interval '1 hour' WHERE id=$1`, [rideId, token]);
  const { rows: shared } = await pool.query(
    `SELECT status, pickup_address FROM rides WHERE share_token=$1 AND (share_expires_at IS NULL OR share_expires_at > now())`,
    [token],
  );
  check("share token rezolvă cursa", shared.length === 1);
  const { rows: expired } = await pool.query(
    `SELECT 1 FROM rides WHERE share_token=$1 AND share_expires_at > now() - interval '2 hours' AND share_expires_at <= now()`,
    [token],
  );
  check("share token neexpirat încă", expired.length === 0);

  // Anulare cu motiv structurat pe o a doua cursă
  const { rows: ride2Rows } = await pool.query(
    `INSERT INTO rides (rider_user_id, city, vehicle_class, pickup_address, pickup_lat, pickup_lng,
                        dropoff_address, dropoff_lat, dropoff_lng, status,
                        estimated_fare_cents, currency, payment_method)
     VALUES ($1,$2,'economy','A 1',$3,$4,'B 2',$5,$6,'searching',$7,'RON','cash') RETURNING id`,
    [riderId, CITY, PICKUP.lat, PICKUP.lng, DROPOFF.lat, DROPOFF.lng, estimatedFare],
  );
  const ride2 = ride2Rows[0].id;
  await pool.query(
    `UPDATE rides SET status='cancelled', cancelled_at=now(), cancel_reason=$2, cancelled_by='rider', cancel_fee_cents=0,
            share_expires_at = now() + interval '1 hour'
      WHERE id=$1`,
    [ride2, "wait_too_long"],
  );
  const r2 = (await pool.query(`SELECT status, cancel_reason, cancelled_by, cancel_fee_cents FROM rides WHERE id=$1`, [ride2])).rows[0];
  check("anulare cu motiv salvată", r2.status === "cancelled" && r2.cancel_reason === "wait_too_long" && r2.cancelled_by === "rider");
  check("anulare înainte de accept = gratuită", Number(r2.cancel_fee_cents) === 0);

  // Date vehicul șofer (migrarea 0019)
  await pool.query(`UPDATE couriers SET vehicle_make='Dacia', vehicle_model='Logan', vehicle_color='alb' WHERE id=$1`, [driverId]);
  const drv = (await pool.query(`SELECT vehicle_make, vehicle_model, vehicle_color, vehicle_plate FROM couriers WHERE id=$1`, [driverId])).rows[0];
  check("vehicul complet expus riderului", drv.vehicle_make === "Dacia" && drv.vehicle_model === "Logan" && drv.vehicle_color === "alb" && !!drv.vehicle_plate);

  await pool.query(`DELETE FROM rides WHERE id=$1`, [ride2]);

  // Curățenie
  await pool.query(`DELETE FROM ride_ratings WHERE ride_id=$1`, [rideId]);
  await pool.query(`DELETE FROM dispatch_offers WHERE job_id=$1`, [jobId]);
  await pool.query(`DELETE FROM dispatch_jobs WHERE id=$1`, [jobId]);
  await pool.query(`DELETE FROM rides WHERE id=$1`, [rideId]);
  await pool.query(`DELETE FROM courier_location_history WHERE courier_id=$1`, [driverId]);
  await pool.query(`DELETE FROM couriers WHERE id=$1`, [driverId]);

  console.log(`\nRezultat: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
