#!/usr/bin/env node
/**
 * FRONT R5 — test integrare plăți & payout (direct pe DB, ca test-ride-flow.mjs).
 *
 *   DATABASE_URL=postgres://... node scripts/test-payout-flow.mjs
 *
 * Verifică (cu reimplementare 1:1 a logicii din lib/payments/mobility.ts +
 * lib/wallet/ledger.ts — nu putem importa TS din .mjs):
 *  1. cursă CASH completed → DEBIT = comisionul platformei (datorie, sold negativ permis);
 *  2. cursă CARD completed → CREDIT net = cota curierului + bacșiș;
 *  3. re-decontarea aceleiași curse e no-op (idempotență pe ref);
 *  4. comandă Eats CASH → datorie = merchant + comision, merchant_settlement creat;
 *  5. earnings: sumele agregate pe surse corespund;
 *  6. payout: cerere peste sold → respinsă; cerere validă → debit + pending.
 */
import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const rawLine of readFileSync(f, "utf8").split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL lipsă. Test sărit.");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

// ─── ledger (reimplementare 1:1, cu allowNegative) ──────────────────────────
async function applyEntry(kind, { userId, amountCents, refType, refId, allowNegative = false, metadata = {} }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT id FROM wallet_ledger_entries WHERE ref_type=$1 AND ref_id=$2 AND kind=$3 LIMIT 1`,
      [refType, refId, kind],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { alreadyApplied: true };
    }
    await client.query(`INSERT INTO wallet_balances (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    const locked = await client.query(`SELECT balance_cents FROM wallet_balances WHERE user_id=$1 FOR UPDATE`, [userId]);
    const balance = Number(locked.rows[0].balance_cents);
    const delta = kind === "credit" ? amountCents : -amountCents;
    const newBalance = balance + delta;
    if (newBalance < 0 && !allowNegative) {
      await client.query("ROLLBACK");
      return { error: "insufficient_funds", balance };
    }
    const ins = await client.query(
      `INSERT INTO wallet_ledger_entries (user_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (ref_type, ref_id, kind) DO NOTHING RETURNING id`,
      [userId, kind, amountCents, newBalance, refType, refId, JSON.stringify(metadata)],
    );
    if (!ins.rows[0]) {
      await client.query("COMMIT");
      return { alreadyApplied: true };
    }
    await client.query(`UPDATE wallet_balances SET balance_cents=$2, updated_at=now() WHERE user_id=$1`, [userId, newBalance]);
    await client.query("COMMIT");
    return { alreadyApplied: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── split (identic cu lib/pricing/split.ts) ────────────────────────────────
function computeSplit({ items_cents = 0, fee_cents, tip_cents = 0, platform_commission_pct, courier_share_pct }) {
  const items = Math.max(0, Math.trunc(items_cents));
  const fee = Math.max(0, Math.trunc(fee_cents));
  const tip = Math.max(0, Math.trunc(tip_cents));
  const platformFromItems = Math.round((items * platform_commission_pct) / 100);
  const merchant_cents = items - platformFromItems;
  const courier_cents = Math.round((fee * courier_share_pct) / 100);
  const platform_cents = items + fee - merchant_cents - courier_cents;
  return { platform_cents, merchant_cents, courier_cents, tip_cents: tip };
}

// ─── settle (identic cu lib/payments/mobility.ts) ───────────────────────────
async function settleRide(rideId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.status, r.final_fare_cents, r.estimated_fare_cents,
            COALESCE(r.tip_cents,0)::int AS tip_cents, r.payment_method, r.pricing_zone_id,
            c.user_id AS driver_user_id
       FROM rides r LEFT JOIN couriers c ON c.id = r.driver_id WHERE r.id = $1`,
    [rideId],
  );
  const ride = rows[0];
  if (!ride || ride.status !== "completed" || !ride.driver_user_id) return null;
  const fare = ride.final_fare_cents ?? ride.estimated_fare_cents ?? 0;
  let pct = { platform: 20, courier: 80 };
  if (ride.pricing_zone_id) {
    const z = await pool.query(`SELECT platform_commission_pct, courier_share_pct FROM pricing_zones WHERE id=$1`, [ride.pricing_zone_id]);
    if (z.rows[0]) pct = { platform: Number(z.rows[0].platform_commission_pct), courier: Number(z.rows[0].courier_share_pct) };
  }
  const split = computeSplit({ fee_cents: fare, tip_cents: ride.tip_cents, platform_commission_pct: pct.platform, courier_share_pct: pct.courier });
  const isCash = (ride.payment_method ?? "cash") === "cash";
  let r;
  if (isCash) {
    r = await applyEntry("debit", { userId: ride.driver_user_id, amountCents: split.platform_cents, refType: "ride", refId: ride.id, allowNegative: true, metadata: { split } });
  } else {
    r = await applyEntry("credit", { userId: ride.driver_user_id, amountCents: split.courier_cents + split.tip_cents, refType: "ride", refId: ride.id, metadata: { split } });
  }
  await pool.query(`UPDATE rides SET settled_at = COALESCE(settled_at, now()) WHERE id = $1`, [rideId]);
  return { split, alreadySettled: r.alreadyApplied === true };
}

async function settleOrder(orderId) {
  const { rows } = await pool.query(
    `SELECT lo.id, lo.status, lo.merchant_id, COALESCE(lo.subtotal_cents,0)::int AS subtotal_cents,
            COALESCE(lo.delivery_fee_cents,0)::int AS delivery_fee_cents, COALESCE(lo.tip_cents,0)::int AS tip_cents,
            lo.payment_method, lo.pricing_zone_id, c.user_id AS courier_user_id
       FROM local_orders lo LEFT JOIN couriers c ON c.id = lo.courier_id WHERE lo.id = $1`,
    [orderId],
  );
  const o = rows[0];
  if (!o || o.status !== "delivered" || !o.courier_user_id) return null;
  const split = computeSplit({ items_cents: o.subtotal_cents, fee_cents: o.delivery_fee_cents, tip_cents: o.tip_cents, platform_commission_pct: 20, courier_share_pct: 80 });
  const isCash = (o.payment_method ?? "cash") === "cash";
  if (isCash) {
    await applyEntry("debit", { userId: o.courier_user_id, amountCents: split.platform_cents + split.merchant_cents, refType: "order", refId: o.id, allowNegative: true, metadata: { split } });
    if (split.merchant_cents > 0) {
      await pool.query(
        `INSERT INTO merchant_settlements (merchant_id, order_id, amount_cents, source)
         VALUES ($1,$2,$3,'cash_with_courier') ON CONFLICT (order_id) DO NOTHING`,
        [o.merchant_id, o.id, split.merchant_cents],
      );
    }
  } else {
    await applyEntry("credit", { userId: o.courier_user_id, amountCents: split.courier_cents + split.tip_cents, refType: "order", refId: o.id, metadata: { split } });
    if (split.merchant_cents > 0) {
      await pool.query(
        `INSERT INTO merchant_settlements (merchant_id, order_id, amount_cents, source)
         VALUES ($1,$2,$3,'platform_owes') ON CONFLICT (order_id) DO NOTHING`,
        [o.merchant_id, o.id, split.merchant_cents],
      );
    }
  }
  await pool.query(`UPDATE local_orders SET settled_at = COALESCE(settled_at, now()) WHERE id = $1`, [orderId]);
  return { split };
}

async function balance(userId) {
  const { rows } = await pool.query(`SELECT COALESCE(balance_cents,0)::int8 AS b FROM wallet_balances WHERE user_id=$1`, [userId]);
  return Number(rows[0]?.b ?? 0);
}

// ─── setup fixtures ──────────────────────────────────────────────────────────
const suffix = Date.now();
const cleanup = { users: [], couriers: [], rides: [], orders: [], merchants: [], payouts: [] };

async function mkUser(name) {
  const email = `payout-test-${name}-${suffix}@test.local`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, display_name, username, role) VALUES ($1,$2,$3,'shopper') RETURNING id`,
    [email, `Payout ${name}`, `payout_${name}_${createHash("md5").update(email).digest("hex").slice(0, 6)}`],
  );
  cleanup.users.push(rows[0].id);
  return rows[0].id;
}

try {
  const riderId = await mkUser("rider");
  const driverUserId = await mkUser("driver");

  const { rows: courierRows } = await pool.query(
    `INSERT INTO couriers (user_id, kind, full_name, phone, city, verification_status)
     VALUES ($1, 'driver', 'Payout Test Driver', '0700000000', 'București', 'approved') RETURNING id`,
    [driverUserId],
  );
  const driverId = courierRows[0].id;
  cleanup.couriers.push(driverId);

  async function mkRide(paymentMethod, fareCents, tipCents = 0) {
    const { rows } = await pool.query(
      `INSERT INTO rides (rider_user_id, driver_id, pickup_address, pickup_lat, pickup_lng,
                          dropoff_address, dropoff_lat, dropoff_lng, status,
                          estimated_fare_cents, final_fare_cents, tip_cents, payment_method,
                          requested_at, completed_at)
       VALUES ($1,$2,'A',44.43,26.10,'B',44.45,26.12,'completed',$3,$3,$4,$5,now(),now())
       RETURNING id`,
      [riderId, driverId, fareCents, tipCents, paymentMethod],
    );
    cleanup.rides.push(rows[0].id);
    return rows[0].id;
  }

  // 1. Cursă CASH 40.00 RON → datorie = 20% = 8.00 RON (sold -800)
  const cashRide = await mkRide("cash", 4000);
  const s1 = await settleRide(cashRide);
  assert(s1.split.platform_cents === 800, `cash: comision platformă 800 (a fost ${s1.split.platform_cents})`);
  const b1 = await balance(driverUserId);
  assert(b1 === -800, `cash: sold șofer = -800 (datorie comision; a fost ${b1})`);

  // 2. Cursă CARD 50.00 + tip 5.00 → credit net = 80%*5000 + 500 = 4500
  const cardRide = await mkRide("card", 5000, 500);
  const s2 = await settleRide(cardRide);
  const expectedNet = s2.split.courier_cents + s2.split.tip_cents;
  assert(expectedNet === 4500, `card: net curier 4500 (a fost ${expectedNet})`);
  const b2 = await balance(driverUserId);
  assert(b2 === -800 + 4500, `card: sold = 3700 (a fost ${b2})`);

  // 3. Idempotență: re-decontare no-op
  const s3 = await settleRide(cardRide);
  assert(s3.alreadySettled === true, "re-decontarea aceleiași curse e no-op");
  assert((await balance(driverUserId)) === 3700, "soldul nu se schimbă la re-decontare");

  // 4. Eats CASH: items 60.00, fee 10.00, tip 3.00
  //    datorie = platform(items 20% + fee 20%) + merchant(48.00) = 12+2+48... calc:
  //    merchant=4800, courier=800, platform=1400 → datorie 6200; tip 300 rămâne cash la curier.
  const { rows: merchRows } = await pool.query(
    `INSERT INTO local_merchants (name, kind, address, location_city, location_lat, location_lng, status)
     VALUES ('Payout Test Resto', 'restaurant', 'Str. Test 1', 'București', 44.43, 26.10, 'active') RETURNING id`,
  );
  const merchantId = merchRows[0].id;
  cleanup.merchants.push(merchantId);
  const { rows: orderRows } = await pool.query(
    `INSERT INTO local_orders (order_number, merchant_id, customer_user_id, customer_name, customer_phone,
                               delivery_address, delivery_lat, delivery_lng, items,
                               subtotal_cents, delivery_fee_cents, tip_cents, total_cents,
                               payment_method, status, courier_id, delivered_at)
     VALUES ($1,$2,$3,'Client Test','0711111111','Str. Livrare 2',44.44,26.11,'[]'::jsonb,
             6000,1000,300,7300,'cash','delivered',$4,now()) RETURNING id`,
    [`PT-${suffix}`, merchantId, riderId, driverId],
  );
  const orderId = orderRows[0].id;
  cleanup.orders.push(orderId);
  const s4 = await settleOrder(orderId);
  const debt = s4.split.platform_cents + s4.split.merchant_cents;
  assert(debt === 6200, `eats cash: datorie 6200 (a fost ${debt})`);
  const b4 = await balance(driverUserId);
  assert(b4 === 3700 - 6200, `eats cash: sold = -2500 (a fost ${b4})`);
  const { rows: ms } = await pool.query(`SELECT source, amount_cents::int8 AS a FROM merchant_settlements WHERE order_id=$1`, [orderId]);
  assert(ms[0]?.source === "cash_with_courier" && Number(ms[0]?.a) === 4800, "merchant_settlement cash_with_courier 4800 creat");

  // 5. Earnings: sumele semnate din ledger
  const { rows: earn } = await pool.query(
    `SELECT ref_type, SUM(CASE WHEN kind='credit' THEN amount_cents ELSE -amount_cents END)::int8 AS net
       FROM wallet_ledger_entries WHERE user_id=$1 AND ref_type IN ('ride','order') GROUP BY ref_type`,
    [driverUserId],
  );
  const go = Number(earn.find((e) => e.ref_type === "ride")?.net ?? 0);
  const eats = Number(earn.find((e) => e.ref_type === "order")?.net ?? 0);
  assert(go === 3700, `earnings go = 3700 (a fost ${go})`);
  assert(eats === -6200, `earnings eats = -6200 (a fost ${eats})`);

  // 6. Payout: sold e -2500 → cerere de 5000 refuzată (insufficient)
  const r6 = await applyEntry("debit", { userId: driverUserId, amountCents: 5000, refType: "payout", refId: randomUUID() });
  assert(r6.error === "insufficient_funds", "payout cu sold insuficient e respins");

  // aducem soldul pe plus și cerem payout valid
  await applyEntry("credit", { userId: driverUserId, amountCents: 10000, refType: "test_topup", refId: randomUUID() });
  const { rows: prRows } = await pool.query(
    `INSERT INTO payout_requests (user_id, amount_cents) VALUES ($1, 5000) RETURNING id`,
    [driverUserId],
  );
  cleanup.payouts.push(prRows[0].id);
  const r7 = await applyEntry("debit", { userId: driverUserId, amountCents: 5000, refType: "payout", refId: prRows[0].id });
  assert(r7.alreadyApplied === false, "payout valid: debit aplicat");
  const b7 = await balance(driverUserId);
  assert(b7 === -2500 + 10000 - 5000, `sold după payout = 2500 (a fost ${b7})`);

  console.log(process.exitCode ? "\n❌ Teste eșuate." : "\n✅ Toate testele payout-flow au trecut.");
} finally {
  // curățenie
  await pool.query(`DELETE FROM merchant_settlements WHERE order_id = ANY($1::uuid[])`, [cleanup.orders]).catch(() => {});
  await pool.query(`DELETE FROM payout_requests WHERE id = ANY($1::uuid[])`, [cleanup.payouts]).catch(() => {});
  await pool.query(`DELETE FROM local_orders WHERE id = ANY($1::uuid[])`, [cleanup.orders]).catch(() => {});
  await pool.query(`DELETE FROM local_merchants WHERE id = ANY($1::uuid[])`, [cleanup.merchants]).catch(() => {});
  await pool.query(`DELETE FROM rides WHERE id = ANY($1::uuid[])`, [cleanup.rides]).catch(() => {});
  await pool.query(`DELETE FROM wallet_ledger_entries WHERE user_id = ANY($1::uuid[])`, [cleanup.users]).catch(() => {});
  await pool.query(`DELETE FROM wallet_balances WHERE user_id = ANY($1::uuid[])`, [cleanup.users]).catch(() => {});
  await pool.query(`DELETE FROM couriers WHERE id = ANY($1::uuid[])`, [cleanup.couriers]).catch(() => {});
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [cleanup.users]).catch(() => {});
  await pool.end();
}
