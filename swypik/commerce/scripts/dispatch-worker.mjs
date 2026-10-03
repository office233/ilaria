#!/usr/bin/env node
/**
 * Dispatch worker — apelează /api/cron/dispatch-tick la fiecare 10 secunde.
 *
 * Rulare (proces separat, ex. systemd / pm2 / docker sidecar):
 *   DISPATCH_TICK_URL=https://swypik.ro/api/cron/dispatch-tick \
 *   CRON_SECRET=... node scripts/dispatch-worker.mjs
 *
 * Env:
 *   DISPATCH_TICK_URL          — default http://localhost:3000/api/cron/dispatch-tick
 *   CRON_SECRET                — obligatoriu (header x-cron-secret)
 *   DISPATCH_TICK_INTERVAL_MS  — default 10000
 */
const url = process.env.DISPATCH_TICK_URL || "http://localhost:3000/api/cron/dispatch-tick";
const secret = process.env.CRON_SECRET;
const intervalMs = Number(process.env.DISPATCH_TICK_INTERVAL_MS) || 10_000;

if (!secret) {
  console.error("[dispatch-worker] CRON_SECRET missing");
  process.exit(1);
}

let running = false;

async function tickOnce() {
  if (running) return; // nu suprapune tick-urile
  running = true;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-cron-secret": secret },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[dispatch-worker] tick HTTP ${res.status}`, body);
    } else if (body.expiredOffers || body.advancedWaves || body.noCourier) {
      console.log(
        `[dispatch-worker] expired=${body.expiredOffers} waves=${body.advancedWaves} no_courier=${body.noCourier}`,
      );
    }
  } catch (err) {
    console.error("[dispatch-worker] tick failed:", err?.message || err);
  } finally {
    running = false;
  }
}

console.log(`[dispatch-worker] started — ${url} @ ${intervalMs}ms`);
tickOnce();
setInterval(tickOnce, intervalMs);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
