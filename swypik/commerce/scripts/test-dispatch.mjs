#!/usr/bin/env node
/**
 * Test integrare dispatch engine — rulează direct pe DB (fără HTTP).
 *
 *   DATABASE_URL=postgres://... node scripts/test-dispatch.mjs
 *
 * Scenarii:
 *  1. Concurență: 5 joburi, 20 curieri; TOȚI curierii cu ofertă acceptă
 *     concurent → fiecare job are exact 1 curier, zero dublă-asignare,
 *     un curier nu poate lua două joburi din același val de accept-uri.
 *  2. Valuri: job fără accept → tick-urile cresc raza (wave 0→1→2), după
 *     3 valuri fără accept → status 'no_courier' + local_orders.dispatch_status.
 *
 * Toate datele de test sunt create și șterse într-o schemă efemeră de date
 * (rânduri marcate cu oraș unic), cleanup la final.
 */
import { Pool } from "pg";
import crypto from "node:crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const CITY = `__test_dispatch_${crypto.randomUUID().slice(0, 8)}`;

// SQL-urile de accept reproduc logica din lib/dispatch/engine.ts acceptOffer()
// (nu putem importa TS cu path alias din .mjs — menținem sincron manual).
async function acceptOffer(jobId, courierId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: jobs } = await client.query(
      `SELECT * FROM dispatch_jobs WHERE id = $1 AND status IN ('searching','assigned') FOR UPDATE`,
      [jobId],
    );
    const job = jobs[0];
    if (!job || job.assigned_courier_id) {
      await client.query("ROLLBACK");
      return false;
    }
    const { rows: offer } = await client.query(
      `SELECT id FROM dispatch_offers
        WHERE job_id = $1 AND courier_id = $2 AND response IS NULL AND expires_at > now()
        FOR UPDATE`,
      [jobId, courierId],
    );
    if (!offer.length) {
      await client.query("ROLLBACK");
      return false;
    }
    // anti double-booking: lock pe curier + check job activ
    await client.query(`SELECT id FROM couriers WHERE id = $1 FOR UPDATE`, [courierId]);
    const { rows: busy } = await client.query(
      `SELECT id FROM dispatch_jobs WHERE assigned_courier_id = $1 AND status = 'assigned'`,
      [courierId],
    );
    if (busy.length) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(`UPDATE dispatch_offers SET response='accepted', responded_at=now() WHERE id=$1`, [offer[0].id]);
    await client.query(
      `UPDATE dispatch_offers SET response='expired', responded_at=now() WHERE job_id=$1 AND response IS NULL`,
      [jobId],
    );
    await client.query(
      `UPDATE dispatch_jobs SET status='assigned', assigned_courier_id=$2, assigned_at=now(), updated_at=now() WHERE id=$1`,
      [jobId, courierId],
    );
    const { rows: locked } = await client.query(
      `SELECT courier_id FROM local_orders WHERE id = $1 FOR UPDATE`,
      [job.order_id],
    );
    if (locked[0]?.courier_id) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE local_orders SET courier_id=$2, dispatch_status='assigned', updated_at=now() WHERE id=$1`,
      [job.order_id, courierId],
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // serialization/lock errors count as failed accept
    if (!/deadlock|could not/i.test(String(err?.message))) throw err;
    return false;
  } finally {
    client.release();
  }
}

async function tick() {
  await pool.query(
    `UPDATE dispatch_offers SET response='expired', responded_at=now() WHERE response IS NULL AND expires_at < now()`,
  );
  const { rows: stalled } = await pool.query(
    `SELECT j.* FROM dispatch_jobs j
      WHERE j.status='searching' AND j.city = $1
        AND NOT EXISTS (SELECT 1 FROM dispatch_offers o WHERE o.job_id=j.id AND o.response IS NULL AND o.expires_at > now())`,
    [CITY],
  );
  for (const job of stalled) {
    const nextWave = job.wave + 1;
    if (nextWave >= 3) {
      await pool.query(`UPDATE dispatch_jobs SET status='no_courier', updated_at=now() WHERE id=$1`, [job.id]);
      await pool.query(
        `UPDATE local_orders SET dispatch_status='no_courier', updated_at=now() WHERE id=$1`,
        [job.order_id],
      );
    } else {
      await pool.query(`UPDATE dispatch_jobs SET wave=$2, updated_at=now() WHERE id=$1`, [job.id, nextWave]);
    }
  }
  return stalled.length;
}

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✔ ${msg}`);
  } else {
    failures += 1;
    console.error(`  ✘ FAIL: ${msg}`);
  }
}

async function main() {
  console.log(`[test-dispatch] city marker: ${CITY}`);

  // ── setup: 1 merchant, 20 curieri, 5 comenzi + joburi ────────────────────
  const { rows: mRows } = await pool.query(
    `INSERT INTO local_merchants (name, slug, kind, address, location_city, location_lat, location_lng)
     VALUES ('Test Dispatch', $1, 'restaurant', 'Str. Test 1', $2, 45.0, 25.0)
     RETURNING id`,
    [CITY, CITY],
  );
  const merchantId = mRows[0].id;

  const courierIds = [];
  for (let i = 0; i < 20; i++) {
    const { rows } = await pool.query(
      `INSERT INTO couriers (full_name, phone, kind, vehicle_type, city, is_online, verification_status, current_lat, current_lng)
       VALUES ($1, $2, 'courier', 'bike', $3, true, 'approved', $4, $5)
       RETURNING id`,
      [`Test Courier ${i}`, `07000000${String(i).padStart(2, "0")}`, CITY, 45.0 + i * 0.0001, 25.0],
    );
    courierIds.push(rows[0].id);
  }

  const jobIds = [];
  const orderIds = [];
  for (let i = 0; i < 5; i++) {
    const { rows: o } = await pool.query(
      `INSERT INTO local_orders (merchant_id, customer_name, customer_phone, delivery_address, items, subtotal_cents, total_cents, status, dispatch_status)
       VALUES ($1, 'Client Test', '0711111111', 'Str. Livrare 2', '[]', 1000, 1000, 'ready', 'offered')
       RETURNING id`,
      [merchantId],
    );
    orderIds.push(o[0].id);
    const { rows: j } = await pool.query(
      `INSERT INTO dispatch_jobs (kind, order_id, city, pickup_lat, pickup_lng)
       VALUES ('delivery', $1, $2, 45.0, 25.0) RETURNING id`,
      [o[0].id, CITY],
    );
    jobIds.push(j[0].id);
    // val 0: oferte pentru primii 5 curieri (fiecare job primește aceiași curieri → conflict maxim)
    for (const cid of courierIds.slice(0, 5)) {
      await pool.query(
        `INSERT INTO dispatch_offers (job_id, order_id, courier_id, expires_at, wave)
         VALUES ($1, $2, $3, now() + interval '45 seconds', 0)`,
        [jobIds[i], o[0].id, cid],
      );
    }
  }

  // ── Test 1: accept concurent ──────────────────────────────────────────────
  console.log("\n[1] Concurrent accepts (25 încercări simultane pe 5 joburi):");
  const attempts = [];
  for (const jobId of jobIds) {
    for (const cid of courierIds.slice(0, 5)) {
      attempts.push(acceptOffer(jobId, cid));
    }
  }
  const results = await Promise.all(attempts);
  const wins = results.filter(Boolean).length;

  const { rows: assigned } = await pool.query(
    `SELECT id, assigned_courier_id FROM dispatch_jobs WHERE id = ANY($1) AND status='assigned'`,
    [jobIds],
  );
  assert(assigned.length === 5, `toate cele 5 joburi asignate (${assigned.length}/5)`);
  assert(wins === 5, `exact 5 accept-uri câștigătoare (${wins})`);
  const perJob = await pool.query(
    `SELECT job_id, count(*) FILTER (WHERE response='accepted') AS acc
       FROM dispatch_offers WHERE job_id = ANY($1) GROUP BY job_id`,
    [jobIds],
  );
  assert(
    perJob.rows.every((r) => Number(r.acc) === 1),
    "fiecare job are exact 1 ofertă acceptată (zero dublă-asignare)",
  );
  const { rows: dupCourier } = await pool.query(
    `SELECT assigned_courier_id, count(*) FROM dispatch_jobs
      WHERE id = ANY($1) GROUP BY assigned_courier_id HAVING count(*) > 1`,
    [jobIds],
  );
  assert(dupCourier.length === 0, "niciun curier nu are 2 joburi din același val");
  const { rows: ordersOk } = await pool.query(
    `SELECT count(*) AS n FROM local_orders lo
      JOIN dispatch_jobs j ON j.order_id = lo.id
     WHERE j.id = ANY($1) AND lo.courier_id = j.assigned_courier_id AND lo.dispatch_status='assigned'`,
    [jobIds],
  );
  assert(Number(ordersOk[0].n) === 5, "local_orders.courier_id sincronizat cu jobul");

  // ── Test 2: valuri → no_courier ──────────────────────────────────────────
  console.log("\n[2] Valuri fără accept → no_courier:");
  const { rows: o2 } = await pool.query(
    `INSERT INTO local_orders (merchant_id, customer_name, customer_phone, delivery_address, items, subtotal_cents, total_cents, status, dispatch_status)
     VALUES ($1, 'Client Val', '0722222222', 'Str. Val 3', '[]', 1000, 1000, 'ready', 'offered') RETURNING id`,
    [merchantId],
  );
  const { rows: j2 } = await pool.query(
    `INSERT INTO dispatch_jobs (kind, order_id, city, pickup_lat, pickup_lng)
     VALUES ('delivery', $1, $2, 45.0, 25.0) RETURNING id`,
    [o2[0].id, CITY],
  );
  const waveJobId = j2[0].id;
  // fără nicio ofertă activă → fiecare tick avansează valul
  await tick();
  let { rows: w } = await pool.query(`SELECT wave, status FROM dispatch_jobs WHERE id=$1`, [waveJobId]);
  assert(w[0].wave === 1 && w[0].status === "searching", `tick 1 → wave 1 (got wave=${w[0].wave})`);
  await tick();
  ({ rows: w } = await pool.query(`SELECT wave, status FROM dispatch_jobs WHERE id=$1`, [waveJobId]));
  assert(w[0].wave === 2 && w[0].status === "searching", `tick 2 → wave 2 (got wave=${w[0].wave})`);
  await tick();
  ({ rows: w } = await pool.query(`SELECT wave, status FROM dispatch_jobs WHERE id=$1`, [waveJobId]));
  assert(w[0].status === "no_courier", `tick 3 → no_courier (got ${w[0].status})`);
  const { rows: lo2 } = await pool.query(`SELECT dispatch_status FROM local_orders WHERE id=$1`, [o2[0].id]);
  assert(lo2[0].dispatch_status === "no_courier", "local_orders.dispatch_status = no_courier");

  // ── cleanup ───────────────────────────────────────────────────────────────
  await pool.query(`DELETE FROM dispatch_jobs WHERE city = $1`, [CITY]);
  await pool.query(`DELETE FROM local_orders WHERE merchant_id = $1`, [merchantId]);
  await pool.query(`DELETE FROM couriers WHERE city = $1`, [CITY]);
  await pool.query(`DELETE FROM local_merchants WHERE id = $1`, [merchantId]);

  console.log(failures === 0 ? "\n✅ ALL TESTS PASSED" : `\n❌ ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error("[test-dispatch] fatal:", err);
    process.exit(1);
  })
  .finally(() => pool.end());
