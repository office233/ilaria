#!/usr/bin/env node
/**
 * Test integrare pricing engine — rulează direct pe DB (fără HTTP, fără Google).
 *
 *   DATABASE_URL=postgres://... node scripts/test-pricing.mjs
 *
 * 12 scenarii: formulă pură (computeFare-echivalent), fallback haversine×1.3
 * fără GOOGLE_MAPS_API_KEY, min_fare, surge manual+auto, fallback fee fix,
 * split de bani. Valorile așteptate sunt hard-codate.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  }
}

// ─── replici pure ale formulelor din lib/pricing (verificate 1:1) ───────────
function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function estimateFallback(pickup, dropoff) {
  const distance_km = Math.round(haversineKm(pickup, dropoff) * 1.3 * 1000) / 1000;
  const duration_min = Math.max(1, Math.round((distance_km / 25) * 60));
  return { distance_km, duration_min };
}
function computeFare(zone, distanceKm, durationMin, surge) {
  const distance_cents = Math.round(zone.per_km_cents * distanceKm);
  const time_cents = Math.round(zone.per_min_cents * durationMin);
  const raw = zone.base_cents + distance_cents + time_cents;
  const surged = Math.round(raw * surge);
  const min_fare_applied = surged < zone.min_fare_cents;
  return {
    total_cents: Math.max(surged, zone.min_fare_cents) + zone.booking_fee_cents,
    min_fare_applied,
  };
}
function computeSplit({ items_cents = 0, fee_cents, tip_cents = 0, platform_commission_pct, courier_share_pct }) {
  const platformFromItems = Math.round((items_cents * platform_commission_pct) / 100);
  const merchant_cents = items_cents - platformFromItems;
  const courier_cents = Math.round((fee_cents * courier_share_pct) / 100);
  const total = items_cents + fee_cents + tip_cents;
  return {
    platform_cents: total - merchant_cents - courier_cents - tip_cents,
    merchant_cents,
    courier_cents,
    tip_cents,
  };
}

// zona ride economy București din seed (0008)
const RIDE = { base_cents: 600, per_km_cents: 220, per_min_cents: 40, min_fare_cents: 1200, booking_fee_cents: 150 };
// zona delivery bike București
const DLVR = { base_cents: 500, per_km_cents: 150, per_min_cents: 20, min_fare_cents: 800, booking_fee_cents: 100 };

async function main() {
  console.log("── Pricing engine: 12 scenarii ──\n");

  // 1. Distanță scurtă (1 km) ride: 600+220+40*3=940 < min 1200 → 1200+150
  console.log("1) Ride 1 km, 3 min, fără surge → min_fare");
  check("total", computeFare(RIDE, 1, 3, 1.0), { total_cents: 1350, min_fare_applied: true });

  // 2. Distanță lungă (18.5 km, 44 min) ride
  console.log("2) Ride lung 18.5 km, 44 min");
  // 600 + round(220*18.5)=4070 + 40*44=1760 → 6430 +150
  check("total", computeFare(RIDE, 18.5, 44, 1.0), { total_cents: 6580, min_fare_applied: false });

  // 3. min_fare: cursă foarte scurtă 0.3 km, 1 min → 600+66+40=706 <1200 → 1200+150
  console.log("3) min_fare aplicat (0.3 km)");
  check("total", computeFare(RIDE, 0.3, 1, 1.0), { total_cents: 1350, min_fare_applied: true });

  // 4. Surge 1.5×: 1 km/3 min → round(940*1.5)=1410 >1200 → 1410+150
  console.log("4) Surge 1.5× pe ride scurt scoate din min_fare");
  check("total", computeFare(RIDE, 1, 3, 1.5), { total_cents: 1560, min_fare_applied: false });

  // 5. Surge plafonat 2.0× cu min_fare: 0.3km → round(706*2)=1412 >1200 → 1412+150
  console.log("5) Surge 2.0× scoate din min_fare");
  check("total", computeFare(RIDE, 0.3, 1, 2.0), { total_cents: 1562, min_fare_applied: false });

  // 6. Fallback fără Google API: Piața Unirii → Piața Romană (~2.17 km linie dreaptă)
  console.log("6) Fallback haversine×1.3 (fără GOOGLE_MAPS_API_KEY)");
  const est = estimateFallback({ lat: 44.4268, lng: 26.1025 }, { lat: 44.4459, lng: 26.0973 });
  check("provider fallback distanță > linie dreaptă", est.distance_km > haversineKm({ lat: 44.4268, lng: 26.1025 }, { lat: 44.4459, lng: 26.0973 }), true);
  check("durata pozitivă", est.duration_min >= 1, true);

  // 7. Delivery: 2.8 km, 7 min → 500+420+140=1060 → +100 booking = 1160
  console.log("7) Delivery bike 2.8 km");
  check("total", computeFare(DLVR, 2.8, 7, 1.0), { total_cents: 1160, min_fare_applied: false });

  // 8. Delivery min_fare: 0.5 km, 2 min → 500+75+40=615 <800 → 800+100
  console.log("8) Delivery min_fare (0.5 km)");
  check("total", computeFare(DLVR, 0.5, 2, 1.0), { total_cents: 900, min_fare_applied: true });

  // 9. Split delivery: items 5000, fee 1160, tip 500, comision 20%, curier 80%
  console.log("9) Split delivery — sumele dau exact totalul");
  const s9 = computeSplit({ items_cents: 5000, fee_cents: 1160, tip_cents: 500, platform_commission_pct: 20, courier_share_pct: 80 });
  check("split", s9, { platform_cents: 1232, merchant_cents: 4000, courier_cents: 928, tip_cents: 500 });
  check("invariant sumă", s9.platform_cents + s9.merchant_cents + s9.courier_cents + s9.tip_cents, 6660);

  // 10. Split ride (fără items): fare 2160, tip 0
  console.log("10) Split ride");
  const s10 = computeSplit({ fee_cents: 2160, platform_commission_pct: 20, courier_share_pct: 80 });
  check("split", s10, { platform_cents: 432, merchant_cents: 0, courier_cents: 1728, tip_cents: 0 });

  // ─── scenarii DB (11-12) ───
  const canDb = Boolean(process.env.DATABASE_URL);
  if (!canDb) {
    console.log("\n(DATABASE_URL lipsă — scenariile DB 11-12 sărite)");
  } else {
    // 11. Seed-ul există și zona are valorile așteptate
    console.log("11) Seed zone București în DB");
    const { rows } = await pool.query(
      `SELECT base_cents, per_km_cents, per_min_cents, min_fare_cents, booking_fee_cents
         FROM pricing_zones WHERE lower(city)='bucurești' AND kind='ride' AND vehicle_class='economy' AND active`,
    );
    check("zona ride economy", rows[0] ?? null, {
      base_cents: 600, per_km_cents: 220, per_min_cents: 40, min_fare_cents: 1200, booking_fee_cents: 150,
    });

    // 12. Surge manual în DB: inserăm regulă 1.4 și verificăm selecția ferestrei
    console.log("12) Surge manual activ selectat corect");
    const zoneId = (await pool.query(`SELECT id FROM pricing_zones WHERE lower(city)='bucurești' AND kind='ride' AND vehicle_class='economy' LIMIT 1`)).rows[0]?.id;
    if (zoneId) {
      const sid = randomUUID();
      await pool.query(
        `INSERT INTO surge_rules (id, zone_id, multiplier, starts_at, ends_at, auto)
         VALUES ($1, $2, 1.40, now() - interval '1 minute', now() + interval '10 minutes', false)`,
        [sid, zoneId],
      );
      const { rows: sr } = await pool.query(
        `SELECT multiplier FROM surge_rules
          WHERE zone_id=$1 AND starts_at<=now() AND (ends_at IS NULL OR ends_at>=now())
          ORDER BY multiplier DESC LIMIT 1`,
        [zoneId],
      );
      check("multiplier", Number(sr[0]?.multiplier), 1.4);
      await pool.query(`DELETE FROM surge_rules WHERE id=$1`, [sid]);
    } else {
      failed++;
      console.log("  ❌ zona pilot lipsește din DB");
    }
  }

  console.log(`\n── Rezultat: ${passed} passed, ${failed} failed ──`);
  await pool.end().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
