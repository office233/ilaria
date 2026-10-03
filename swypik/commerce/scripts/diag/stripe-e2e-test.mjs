#!/usr/bin/env node
/**
 * Stripe E2E integration test.
 *
 * Verifies:
 *  1. Webhook rejects missing signature (400)
 *  2. Webhook rejects bad signature (400)
 *  3. Webhook accepts properly signed event + claims idempotency
 *  4. Replay of same event → duplicate=true (idempotency works)
 *  5. Checkout API rejects malformed input (400)
 *  6. Checkout API rejects unknown productId (404)
 *
 * Uses a safe event type ("checkout.session.expired" with fake session id) so
 * no real order is mutated. Requires STRIPE_WEBHOOK_SECRET in env.
 *
 * Usage: BASE_URL=https://swypik.com STRIPE_WEBHOOK_SECRET=whsec_... node scripts/stripe-e2e-test.mjs
 */

import crypto from 'node:crypto';

const BASE = (process.env.BASE_URL || 'https://swypik.com').replace(/\/$/, '');
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET;
if (!WHSEC) { console.error('STRIPE_WEBHOOK_SECRET missing'); process.exit(1); }

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function signPayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signedPayload = `${timestamp}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return { header: `t=${timestamp},v1=${sig}`, timestamp };
}

function buildEvent(type, objectOverrides = {}) {
  const id = `evt_test_${crypto.randomBytes(8).toString('hex')}`;
  const sessId = `cs_test_${crypto.randomBytes(8).toString('hex')}`;
  return {
    id,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: sessId,
        object: 'checkout.session',
        ...objectOverrides,
      },
    },
  };
}

async function postWebhook(payload, signatureHeader) {
  const headers = { 'Content-Type': 'application/json' };
  if (signatureHeader) headers['stripe-signature'] = signatureHeader;
  const res = await fetch(`${BASE}/api/webhooks/stripe`, {
    method: 'POST',
    headers,
    body: payload,
  });
  let body;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status, body };
}

async function test1_missingSignature() {
  const payload = JSON.stringify(buildEvent('checkout.session.expired'));
  const { status, body } = await postWebhook(payload, null);
  record('webhook rejects missing signature', status === 400, `status=${status} body=${JSON.stringify(body).slice(0, 100)}`);
}

async function test2_badSignature() {
  const payload = JSON.stringify(buildEvent('checkout.session.expired'));
  const ts = Math.floor(Date.now() / 1000);
  const fake = `t=${ts},v1=${crypto.randomBytes(32).toString('hex')}`;
  const { status, body } = await postWebhook(payload, fake);
  record('webhook rejects bad signature', status === 400, `status=${status} body=${JSON.stringify(body).slice(0, 100)}`);
}

async function test3_validSignatureAccepted() {
  const evt = buildEvent('checkout.session.expired');
  const payload = JSON.stringify(evt);
  const { header } = signPayload(payload, WHSEC);
  const { status, body } = await postWebhook(payload, header);
  const ok = status === 200 && body?.received === true && body?.duplicate !== true;
  record('webhook accepts valid signed event', ok, `status=${status} body=${JSON.stringify(body).slice(0, 120)}`);
  return evt;
}

async function test4_idempotency(evt) {
  const payload = JSON.stringify(evt);
  const { header } = signPayload(payload, WHSEC);
  const { status, body } = await postWebhook(payload, header);
  const ok = status === 200 && body?.duplicate === true;
  record('webhook deduplicates by event.id', ok, `status=${status} body=${JSON.stringify(body).slice(0, 120)}`);
}

async function test5_checkoutMalformed() {
  const res = await fetch(`${BASE}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ garbage: true }),
  });
  let body; try { body = await res.json(); } catch { body = await res.text(); }
  const ok = res.status >= 400 && res.status < 500;
  record('checkout rejects malformed body', ok, `status=${res.status} body=${JSON.stringify(body).slice(0, 100)}`);
}

async function test6_checkoutUnknownProduct() {
  const res = await fetch(`${BASE}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: '00000000-0000-0000-0000-000000000000', quantity: 1 }] }),
  });
  let body; try { body = await res.json(); } catch { body = await res.text(); }
  const ok = res.status >= 400 && res.status < 500;
  record('checkout rejects unknown productId', ok, `status=${res.status} body=${JSON.stringify(body).slice(0, 100)}`);
}

async function main() {
  console.log(`[stripe-e2e] BASE=${BASE}`);
  await test1_missingSignature();
  await test2_badSignature();
  const evt = await test3_validSignatureAccepted();
  if (evt) await test4_idempotency(evt);
  await test5_checkoutMalformed();
  await test6_checkoutUnknownProduct();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n[stripe-e2e] ${passed}/${results.length} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
