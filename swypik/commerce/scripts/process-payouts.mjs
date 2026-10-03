#!/usr/bin/env node
/**
 * FRONT R5 — procesare payout-uri curieri prin Stripe Connect (transfers).
 *
 *   node scripts/process-payouts.mjs [--dry-run]
 *
 * Rulat manual sau din cron (săptămânal). Pentru fiecare payout_request
 * 'pending' al unui curier cu cont Connect cu payouts_enabled:
 *   1. status → 'processing' (claim atomic — safe la rulări concurente);
 *   2. stripe.transfers.create către contul Connect, idempotencyKey =
 *      payout:{id} → retry-ul NU dublează transferul;
 *   3. succes → 'paid' + stripe_transfer_id + paid_at;
 *      eșec  → 'failed' + failure_reason (suma a fost deja debitată din
 *      wallet la creare; adminul decide recreditarea din /api/admin/courier-payouts).
 *
 * Cererile curierilor FĂRĂ cont Stripe rămân 'pending' → se plătesc manual
 * din admin (fluxul vechi 'paid'/'rejected' rămâne valabil).
 *
 * Env: DATABASE_URL, STRIPE_SECRET_KEY (din .env.local dacă lipsesc).
 */
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

const DRY = process.argv.includes("--dry-run");
if (!process.env.STRIPE_SECRET_KEY && !DRY) {
    console.error("STRIPE_SECRET_KEY lipsește (folosește --dry-run pentru verificare).");
    process.exit(1);
}

const { default: Stripe } = await import("stripe");
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-04-22.dahlia" })
    : null;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows: candidates } = await pool.query(
    `SELECT pr.id, pr.user_id, pr.amount_cents::int8 AS amount_cents, pr.currency,
          c.id AS courier_id, c.stripe_account_id, c.stripe_payouts_enabled
     FROM payout_requests pr
     JOIN couriers c ON c.user_id = pr.user_id
    WHERE pr.status = 'pending'
      AND c.stripe_account_id IS NOT NULL
      AND c.stripe_payouts_enabled
    ORDER BY pr.requested_at
    LIMIT 100`,
);

console.log(`${candidates.length} payout request(s) eligibile Stripe${DRY ? " (dry-run)" : ""}`);

let ok = 0, failed = 0;
for (const p of candidates) {
    if (DRY) {
        console.log(`DRY  ${p.id} → ${p.stripe_account_id} ${p.amount_cents} ${p.currency}`);
        continue;
    }
    // claim atomic
    const { rowCount } = await pool.query(
        `UPDATE payout_requests SET status = 'processing' WHERE id = $1 AND status = 'pending'`,
        [p.id],
    );
    if (!rowCount) continue;

    try {
        const transfer = await stripe.transfers.create(
            {
                amount: Number(p.amount_cents),
                currency: String(p.currency).trim().toLowerCase(),
                destination: p.stripe_account_id,
                metadata: { payout_request_id: p.id, courier_id: p.courier_id },
            },
            { idempotencyKey: `payout:${p.id}` },
        );
        await pool.query(
            `UPDATE payout_requests
          SET status = 'paid', stripe_transfer_id = $2, paid_at = now(), resolved_at = now(), resolved_by = 'process-payouts'
        WHERE id = $1`,
            [p.id, transfer.id],
        );
        console.log(`PAID ${p.id} transfer=${transfer.id}`);
        ok++;
    } catch (err) {
        await pool.query(
            `UPDATE payout_requests
          SET status = 'failed', failure_reason = $2, resolved_at = now(), resolved_by = 'process-payouts'
        WHERE id = $1`,
            [p.id, String(err?.message ?? err).slice(0, 500)],
        );
        console.error(`FAIL ${p.id}: ${err?.message ?? err}`);
        failed++;
    }
}

console.log(`Done: ${ok} paid, ${failed} failed.`);
await pool.end();
