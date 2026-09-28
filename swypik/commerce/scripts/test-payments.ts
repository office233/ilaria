/**
 * FRONT R5 — test integrare plăți: rulează logica REALĂ din
 * lib/payments/mobility.ts + lib/payments/platform-account.ts pe DB-ul dev.
 *
 *   npx tsx scripts/test-payments.ts        (sau: npm run test:payments)
 *
 * Verifică:
 *  1. cursă CASH completed → debit comision (sold negativ = datorie);
 *  2. cursă CARD completed → credit net (cotă + tip 100% curier);
 *  3. idempotență: dublul settle (≈ dublul webhook) nu mișcă bani;
 *  4. comandă Eats CASH delivered → datorie merchant+comision, settlement 'cash_with_courier';
 *  5. comandă Eats CARD delivered → credit curier, settlement 'platform_owes';
 *  6. comisionul platformei există în ledger pe contul tehnic (commission_ride/commission_order)
 *     cu gmv_cents în metadata — sursa raportului /api/admin/finance/summary;
 *  7. tip 100% curier (verificat prin split-ul din metadata).
 *
 * Plata cu CARD reală (PaymentIntent + webhook) cere Stripe CLI:
 *   stripe listen --forward-to localhost:3000/api/webhooks/stripe
 *   stripe trigger payment_intent.succeeded --add "payment_intent:metadata[kind]=local_order" \
 *     --add "payment_intent:metadata[local_order_id]=<uuid>"
 * — nu blocăm testul pe ele; aici testăm decontarea, care e independentă de
 * metoda prin care s-au încasat banii.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    for (const rawLine of readFileSync(f, "utf8").split("\n")) {
        const line = rawLine.replace(/\r$/, "").trim();
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
}

import { dbQuery, getDb } from "../lib/db";
import { settleRide, settleLocalOrder } from "../lib/payments/mobility";
import { getPlatformUserId } from "../lib/payments/platform-account";
import { getBalanceCents } from "../lib/wallet/ledger";

let failures = 0;
function assert(cond: unknown, msg: string) {
    if (cond) console.log(`PASS: ${msg}`);
    else {
        console.error(`FAIL: ${msg}`);
        failures++;
    }
}

const suffix = Date.now();
const cleanup = {
    users: [] as string[],
    couriers: [] as string[],
    rides: [] as string[],
    orders: [] as string[],
    merchants: [] as string[],
};

async function mkUser(name: string): Promise<string> {
    const email = `pay-test-${name}-${suffix}@test.local`;
    const { rows } = await dbQuery<{ id: string }>(
        `INSERT INTO users (email, display_name, username, role) VALUES ($1,$2,$3,'shopper') RETURNING id`,
        [email, `Pay ${name}`, `pay_${name}_${createHash("md5").update(email).digest("hex").slice(0, 6)}`],
    );
    cleanup.users.push(rows[0].id);
    return rows[0].id;
}

async function main() {
    const platformId = await getPlatformUserId();
    const platformBefore = await getBalanceCents(platformId);

    const riderId = await mkUser("rider");
    const driverUserId = await mkUser("driver");

    const { rows: courierRows } = await dbQuery<{ id: string }>(
        `INSERT INTO couriers (user_id, kind, full_name, phone, city, verification_status)
     VALUES ($1, 'driver', 'Pay Test Driver', '0700000001', 'București', 'approved') RETURNING id`,
        [driverUserId],
    );
    const driverId = courierRows[0].id;
    cleanup.couriers.push(driverId);

    async function mkRide(paymentMethod: string, fareCents: number, tipCents = 0): Promise<string> {
        const { rows } = await dbQuery<{ id: string }>(
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

    // 1. CASH ride 40.00 → datorie comision 8.00
    const cashRide = await mkRide("cash", 4000);
    const s1 = await settleRide(cashRide);
    assert(s1?.split.platform_cents === 800, `cash ride: comision 800 (${s1?.split.platform_cents})`);
    assert((await getBalanceCents(driverUserId)) === -800, "cash ride: sold șofer -800 (datorie)");

    // 2. CARD ride 50.00 + tip 5.00 → credit 4500 (tip 100% curier)
    const cardRide = await mkRide("card", 5000, 500);
    const s2 = await settleRide(cardRide);
    assert(s2?.split.tip_cents === 500, "tip 100% curier în split");
    assert(
        s2 && s2.ledger_kind === "credit" && s2.ledger_amount_cents === 4500,
        `card ride: credit net 4500 (${s2?.ledger_amount_cents})`,
    );
    assert((await getBalanceCents(driverUserId)) === 3700, "sold după card ride = 3700");

    // 3. Idempotență — dublul settle (echivalentul dublului webhook)
    const s3 = await settleRide(cardRide);
    assert(s3?.alreadySettled === true, "dublu settle e no-op");
    assert((await getBalanceCents(driverUserId)) === 3700, "soldul neschimbat la dublu settle");

    // 4+5. Eats: comenzi cash și card
    const { rows: merchRows } = await dbQuery<{ id: string }>(
        `INSERT INTO local_merchants (name, kind, address, location_city, location_lat, location_lng, status)
     VALUES ('Pay Test Resto', 'restaurant', 'Str. Test 1', 'București', 44.43, 26.10, 'active') RETURNING id`,
    );
    const merchantId = merchRows[0].id;
    cleanup.merchants.push(merchantId);

    async function mkOrder(paymentMethod: string, n: number): Promise<string> {
        const { rows } = await dbQuery<{ id: string }>(
            `INSERT INTO local_orders (order_number, merchant_id, customer_user_id, customer_name, customer_phone,
                                 delivery_address, delivery_lat, delivery_lng, items,
                                 subtotal_cents, delivery_fee_cents, tip_cents, total_cents,
                                 payment_method, status, courier_id, delivered_at)
       VALUES ($1,$2,$3,'Client Test','0711111112','Str. Livrare 2',44.44,26.11,'[]'::jsonb,
               6000,1000,300,7300,$4,'delivered',$5,now()) RETURNING id`,
            [`PAY-${suffix}-${n}`, merchantId, riderId, paymentMethod, driverId],
        );
        cleanup.orders.push(rows[0].id);
        return rows[0].id;
    }

    // 4. Eats CASH: merchant 4800, courier 800+300 tip cash, platform 1400 → datorie 6200
    const cashOrder = await mkOrder("cash", 1);
    const s4 = await settleLocalOrder(cashOrder);
    assert(
        s4 && s4.ledger_kind === "debit" && s4.ledger_amount_cents === 6200,
        `eats cash: datorie 6200 (${s4?.ledger_amount_cents})`,
    );
    const { rows: ms4 } = await dbQuery<{ source: string; a: string }>(
        `SELECT source, amount_cents::int8 AS a FROM merchant_settlements WHERE order_id = $1`,
        [cashOrder],
    );
    assert(ms4[0]?.source === "cash_with_courier" && Number(ms4[0]?.a) === 4800, "settlement cash_with_courier 4800");

    // 5. Eats CARD: credit curier 800 + 300 = 1100, settlement platform_owes
    const cardOrder = await mkOrder("card_online", 2);
    const s5 = await settleLocalOrder(cardOrder);
    assert(
        s5 && s5.ledger_kind === "credit" && s5.ledger_amount_cents === 1100,
        `eats card: credit 1100 (${s5?.ledger_amount_cents})`,
    );
    const { rows: ms5 } = await dbQuery<{ source: string; a: string }>(
        `SELECT source, amount_cents::int8 AS a FROM merchant_settlements WHERE order_id = $1`,
        [cardOrder],
    );
    assert(ms5[0]?.source === "platform_owes" && Number(ms5[0]?.a) === 4800, "settlement platform_owes 4800");

    // 6. Comisionul platformei în ledger (2 rides à 800+1000, 2 orders à 1400)
    const { rows: comm } = await dbQuery<{ ref_type: string; total: string; gmv: string }>(
        `SELECT ref_type, SUM(amount_cents)::int8 AS total,
            SUM((metadata->>'gmv_cents')::bigint)::int8 AS gmv
       FROM wallet_ledger_entries
      WHERE user_id = $1 AND ref_id = ANY($2::text[])
      GROUP BY ref_type`,
        [platformId, [...cleanup.rides, ...cleanup.orders]],
    );
    const rideComm = Number(comm.find((c) => c.ref_type === "commission_ride")?.total ?? 0);
    const orderComm = Number(comm.find((c) => c.ref_type === "commission_order")?.total ?? 0);
    assert(rideComm === 800 + 1000, `commission_ride total 1800 (${rideComm})`);
    assert(orderComm === 1400 * 2, `commission_order total 2800 (${orderComm})`);
    const gmvRide = Number(comm.find((c) => c.ref_type === "commission_ride")?.gmv ?? 0);
    assert(gmvRide === 4000 + 5500, `gmv_cents rides 9500 (${gmvRide})`);

    const platformAfter = await getBalanceCents(platformId);
    assert(
        platformAfter - platformBefore === 1800 + 2800,
        `soldul platformei +4600 (${platformAfter - platformBefore})`,
    );

    console.log(failures ? `\n❌ ${failures} test(e) eșuate.` : "\n✅ Toate testele test-payments au trecut.");
    if (failures) process.exitCode = 1;
}

(async () => {
    try {
        await main();
    } catch (err) {
        console.error("Test crash:", err);
        process.exitCode = 1;
    } finally {
        await dbQuery(`DELETE FROM merchant_settlements WHERE order_id = ANY($1::uuid[])`, [cleanup.orders]).catch(() => { });
        await dbQuery(`DELETE FROM local_orders WHERE id = ANY($1::uuid[])`, [cleanup.orders]).catch(() => { });
        await dbQuery(`DELETE FROM local_merchants WHERE id = ANY($1::uuid[])`, [cleanup.merchants]).catch(() => { });
        await dbQuery(`DELETE FROM rides WHERE id = ANY($1::uuid[])`, [cleanup.rides]).catch(() => { });
        await dbQuery(`DELETE FROM wallet_ledger_entries WHERE user_id = ANY($1::uuid[])`, [cleanup.users]).catch(() => { });
        await dbQuery(
            `DELETE FROM wallet_ledger_entries WHERE ref_id = ANY($1::text[])`,
            [[...cleanup.rides, ...cleanup.orders]],
        ).catch(() => { });
        await dbQuery(`DELETE FROM wallet_balances WHERE user_id = ANY($1::uuid[])`, [cleanup.users]).catch(() => { });
        await dbQuery(`DELETE FROM couriers WHERE id = ANY($1::uuid[])`, [cleanup.couriers]).catch(() => { });
        await dbQuery(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [cleanup.users]).catch(() => { });
        await getDb().end();
    }
})();
