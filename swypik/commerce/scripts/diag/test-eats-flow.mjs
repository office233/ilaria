#!/usr/bin/env node
/**
 * Test integrare Swypik Eats — flux client end-to-end, direct pe DB (fără HTTP).
 *
 *   DATABASE_URL=postgres://... node scripts/test-eats-flow.mjs
 *
 * Scenariu:
 *  1. Seed: merchant activ cu meniu (2 iteme, unul cu opțiuni), curier online.
 *  2. Plasare comandă cash cu recalcul server-side al prețurilor
 *     (reproduce logica din POST /api/local-orders: item + opțiuni + taxă fixă).
 *  3. Fluxul de statusuri: placed → accepted → preparing → ready → picked_up
 *     → delivering → delivered, cu timestamps.
 *  4. Dispatch: job creat, ofertă, accept → local_orders.courier_id setat.
 *  5. Verificări: totaluri corecte, dispatch_status='assigned', delivered_at setat.
 *
 * Datele de test sunt marcate cu un oraș unic; cleanup complet la final.
 */
import { Pool } from "pg";
import crypto from "node:crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const CITY = `__test_eats_${crypto.randomUUID().slice(0, 8)}`;

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.error(`  ✘ ${name} ${extra}`); }
}

async function main() {
  console.log(`[eats-flow] oraș de test: ${CITY}`);

  // ── 1. seed ──
  const { rows: [merchant] } = await pool.query(
    `INSERT INTO local_merchants (kind, name, slug, status, location_city,
        location_lat, location_lng, delivery_fee_cents, min_order_cents, avg_prep_minutes)
     VALUES ('restaurant', 'Test Eats', $1, 'active', $2, 44.43, 26.10, 700, 2000, 20)
     RETURNING id, delivery_fee_cents, avg_prep_minutes`,
    [`test-eats-${CITY}`, CITY],
  );

  const { rows: [pizza] } = await pool.query(
    `INSERT INTO menu_items (merchant_id, name, price_cents, is_available, options)
     VALUES ($1, 'Pizza Test', 3500, true,
       '[{"name":"Blat","required":true,"choices":[{"name":"Subțire","price_cents":0},{"name":"Pufos","price_cents":300}]}]'::jsonb)
     RETURNING id`,
    [merchant.id],
  );
  const { rows: [cola] } = await pool.query(
    `INSERT INTO menu_items (merchant_id, name, price_cents, is_available, options)
     VALUES ($1, 'Cola Test', 800, true, '[]'::jsonb) RETURNING id`,
    [merchant.id],
  );

  const { rows: [courier] } = await pool.query(
    `INSERT INTO couriers (kind, full_name, phone, vehicle_type, city,
        verification_status, is_online, current_lat, current_lng, location_updated_at)
     VALUES ('courier', 'Curier Test', '+40700000000', 'bike', $1,
        'approved', true, 44.44, 26.11, now())
     RETURNING id`,
    [CITY],
  );

  // ── 2. plasare comandă (recalcul server-side, ca POST /api/local-orders) ──
  console.log("\n[1] Plasare comandă cash");
  // client trimite: pizza x2 cu opțiunea "Blat:Pufos" (+300), cola x1
  const pizzaUnit = 3500 + 300;
  const subtotal = pizzaUnit * 2 + 800; // 8400
  const deliveryFee = merchant.delivery_fee_cents; // fallback fix (fără zonă delivery pe orașul de test)
  const tip = 200;
  const total = subtotal + deliveryFee + tip;
  const items = JSON.stringify([
    { menu_item_id: pizza.id, name: "Pizza Test", qty: 2, unit_price_cents: pizzaUnit, options: [{ name: "Pufos", price_cents: 300 }] },
    { menu_item_id: cola.id, name: "Cola Test", qty: 1, unit_price_cents: 800, options: [] },
  ]);
  const { rows: [order] } = await pool.query(
    `INSERT INTO local_orders (merchant_id, customer_name, customer_phone,
        delivery_address, delivery_lat, delivery_lng, items,
        subtotal_cents, delivery_fee_cents, tip_cents, total_cents,
        payment_method, estimated_delivery_at)
     VALUES ($1, 'Client Test', '+40711111111', 'Str. Testului 1', 44.45, 26.12, $2::jsonb,
        $3, $4, $5, $6, 'cash', now() + make_interval(mins => $7))
     RETURNING id, order_number, status, total_cents, estimated_delivery_at`,
    [merchant.id, items, subtotal, deliveryFee, tip, total, merchant.avg_prep_minutes + 15],
  );
  check("comandă creată cu status 'placed'", order.status === "placed");
  check("total = subtotal + livrare + tip", order.total_cents === 8400 + 700 + 200, `(got ${order.total_cents})`);
  check("ETA setat (prep + 15 min)", order.estimated_delivery_at != null);

  // sub minim comandă → ar fi respins de API (verificare logică)
  check("minim comandă respectat", subtotal >= 2000);

  // ── 3. dispatch: job + ofertă + accept ──
  console.log("\n[2] Dispatch curier");
  const { rows: [job] } = await pool.query(
    `INSERT INTO dispatch_jobs (kind, order_id, city, pickup_lat, pickup_lng, status)
     VALUES ('delivery', $1, $2, 44.43, 26.10, 'searching') RETURNING id`,
    [order.id, CITY],
  );
  await pool.query(
    `INSERT INTO dispatch_offers (job_id, courier_id, wave, expires_at)
     VALUES ($1, $2, 0, now() + interval '45 seconds')`,
    [job.id, courier.id],
  );
  await pool.query(`UPDATE local_orders SET dispatch_status='offered' WHERE id=$1`, [order.id]);

  // accept (aceeași secvență ca engine.acceptOffer)
  await pool.query(`UPDATE dispatch_offers SET response='accepted', responded_at=now() WHERE job_id=$1 AND courier_id=$2`, [job.id, courier.id]);
  await pool.query(`UPDATE dispatch_jobs SET status='assigned', assigned_courier_id=$2, assigned_at=now() WHERE id=$1`, [job.id, courier.id]);
  await pool.query(`UPDATE local_orders SET courier_id=$2, dispatch_status='assigned' WHERE id=$1`, [order.id, courier.id]);

  const { rows: [afterDispatch] } = await pool.query(
    `SELECT courier_id, dispatch_status FROM local_orders WHERE id=$1`, [order.id],
  );
  check("curier asignat pe comandă", afterDispatch.courier_id === courier.id);
  check("dispatch_status='assigned'", afterDispatch.dispatch_status === "assigned");

  // ── 4. fluxul de statusuri ──
  console.log("\n[3] Statusuri comandă");
  const transitions = [
    ["accepted", "accepted_at"],
    ["preparing", null],
    ["ready", "ready_at"],
    ["picked_up", "picked_up_at"],
    ["delivering", null],
    ["delivered", "delivered_at"],
  ];
  for (const [st, tsCol] of transitions) {
    await pool.query(
      `UPDATE local_orders SET status=$2${tsCol ? `, ${tsCol}=now()` : ""}, updated_at=now() WHERE id=$1`,
      [order.id, st],
    );
  }
  const { rows: [final] } = await pool.query(
    `SELECT status, accepted_at, ready_at, picked_up_at, delivered_at FROM local_orders WHERE id=$1`,
    [order.id],
  );
  check("status final 'delivered'", final.status === "delivered");
  check("delivered_at setat", final.delivered_at != null);
  check("timestamps intermediare setate", final.accepted_at != null && final.ready_at != null && final.picked_up_at != null);

  // ── 5. query-ul de tracking (GET /api/local-orders/[id]) ──
  console.log("\n[4] Query tracking");
  const { rows: [track] } = await pool.query(
    `SELECT lo.status, m.name AS merchant_name, c.full_name AS courier_name,
            c.current_lat AS courier_lat, j.id AS job_id
       FROM local_orders lo
       JOIN local_merchants m ON m.id = lo.merchant_id
       LEFT JOIN couriers c ON c.id = lo.courier_id
       LEFT JOIN LATERAL (
            SELECT id FROM dispatch_jobs WHERE order_id = lo.id ORDER BY created_at DESC LIMIT 1
       ) j ON true
      WHERE lo.id = $1`,
    [order.id],
  );
  check("tracking: merchant + curier + poziție + job", track.merchant_name === "Test Eats" && track.courier_name === "Curier Test" && track.courier_lat != null && track.job_id === job.id);

    // ── 6. adrese salvate cu geo + instrucțiuni (migrarea 0016) ──
    console.log("\n[5] Adrese salvate (geo + instrucțiuni)");
    const { rows: [tUser] } = await pool.query(
      `INSERT INTO users (email, username) VALUES ($1, $2) RETURNING id`,
      [`${CITY}@test.local`, CITY.slice(0, 30)],
    );
    const { rows: [tAddr] } = await pool.query(
      `INSERT INTO user_addresses (user_id, recipient_name, line1, city, postal_code, lat, lng, details, is_default)
       VALUES ($1, 'Client Test', 'Str. Livrare 2', $2, '300001', 44.4512, 26.1234, 'Interfon 12, et. 3', true)
       RETURNING lat, lng, details`,
      [tUser.id, CITY],
    );
    check("lat/lng persistate pe adresă", Number(tAddr.lat) === 44.4512 && Number(tAddr.lng) === 26.1234);
    check("instrucțiuni curier persistate", tAddr.details === "Interfon 12, et. 3");
    await pool.query(`DELETE FROM user_addresses WHERE user_id=$1`, [tUser.id]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [tUser.id]);

    // ── 7. raza de livrare (logica din POST /api/local-orders) ──
    console.log("\n[6] Raza de livrare");
    const haversineKm = (a, b) => {
      const R = 6371, rad = (d) => (d * Math.PI) / 180;
      const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
        Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    };
    const mPos = { lat: 44.43, lng: 26.10 };
    const inDist = haversineKm(mPos, { lat: 44.45, lng: 26.12 });
    const outDist = haversineKm(mPos, { lat: 44.80, lng: 26.60 });
    check(`adresa comenzii e în raza de 5 km (${inDist.toFixed(2)} km)`, inDist <= 5);
    check(`adresa îndepărtată ar fi respinsă (${outDist.toFixed(1)} km > 5)`, outDist > 5);

  console.log(`\nRezultat: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

async function cleanup() {
  await pool.query(`DELETE FROM dispatch_offers WHERE job_id IN (SELECT id FROM dispatch_jobs WHERE city = $1)`, [CITY]);
  await pool.query(`DELETE FROM dispatch_jobs WHERE city = $1`, [CITY]);
  await pool.query(`DELETE FROM local_orders WHERE merchant_id IN (SELECT id FROM local_merchants WHERE location_city = $1)`, [CITY]);
  await pool.query(`DELETE FROM menu_items WHERE merchant_id IN (SELECT id FROM local_merchants WHERE location_city = $1)`, [CITY]);
  await pool.query(`DELETE FROM couriers WHERE city = $1`, [CITY]);
  await pool.query(`DELETE FROM local_merchants WHERE location_city = $1`, [CITY]);
}

main()
  .then(async (ok) => { await cleanup(); await pool.end(); process.exit(ok ? 0 : 1); })
  .catch(async (err) => {
    console.error("[eats-flow] eroare:", err);
    try { await cleanup(); } catch { /* ignore */ }
    await pool.end();
    process.exit(1);
  });
