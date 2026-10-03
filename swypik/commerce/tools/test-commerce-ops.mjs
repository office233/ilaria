import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadTsModule(relativePath, stubs = {}) {
  const sourcePath = path.join(process.cwd(), relativePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const localRequire = (id) => {
    if (id in stubs) return stubs[id];
    return require(id);
  };

  vm.runInNewContext(compiled, {
    Buffer,
    Request,
    console,
    exports: module.exports,
    module,
    process,
    require: localRequire,
    setTimeout,
    URL,
  });

  return module.exports;
}

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

async function testStripeWebhookSignatureVerification() {
  const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

  let constructEventCalls = 0;
  const fakeStripe = {
    webhooks: {
      constructEvent(rawBody, signature, secret) {
        constructEventCalls += 1;
        assert.equal(Buffer.isBuffer(rawBody), true);
        assert.equal(signature, "t=1,v1=valid");
        assert.equal(secret, "whsec_test");
        return { type: "customer.created", data: { object: {} } };
      },
    },
  };

  const route = loadTsModule("app/api/webhooks/stripe/route.ts", {
    "next/server": {
      NextResponse: {
        json(body, init = {}) {
          return { body, status: init.status || 200 };
        },
      },
    },
    "@/lib/stripe/checkout": { getStripe: () => fakeStripe },
    "@/lib/db": {
      dbQuery: () => {
        throw new Error("dbQuery should not run for unhandled webhook events");
      },
    },
    "@/lib/email/service": {
      sendOrderConfirmation: () => {
        throw new Error("email should not be sent for unhandled webhook events");
      },
    },
    "@/lib/fulfillment/order-router": {
      routeOrder: () => {
        throw new Error("fulfillment should not run for unhandled webhook events");
      },
    },
    "@/lib/security/audit-log": {
      logCheckoutEvent: async () => {},
    },
  });

  try {
    const missingSignature = await route.POST(new Request("http://local.test", {
      method: "POST",
      body: "{}",
    }));
    assert.equal(missingSignature.status, 400);
    assert.equal(missingSignature.body.error, "Missing signature");
    assert.equal(constructEventCalls, 0);

    const accepted = await route.POST(new Request("http://local.test", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=valid" },
      body: "{}",
    }));
    assert.equal(accepted.status, 200);
    assertJsonEqual(accepted.body, { received: true });
    assert.equal(constructEventCalls, 1);
  } finally {
    if (originalSecret === undefined) {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
    }
  }
}

function testOrderStatusHelpers() {
  const {
    canRequestReturn,
    deriveOrderStatus,
  } = loadTsModule("lib/commerce/order-status.ts");

  assertJsonEqual(
    deriveOrderStatus({
      status: "paid",
      metadata: { fulfillment_status: "manual_required" },
    }),
    {
      key: "manual_required",
      label: "Necesita procesare manuala",
      description: "Comanda este platita, dar are nevoie de interventie pentru fulfillment.",
      step: 2,
      isTerminal: false,
      isReturnable: false,
    },
  );

  assert.equal(
    deriveOrderStatus({
      status: "fulfilled",
      metadata: { fulfillment_status: "shipped", tracking_number: "RO123456" },
    }).label,
    "Expediata",
  );

  assert.equal(canRequestReturn({ status: "fulfilled", fulfillmentStatus: "shipped" }), true);
  assert.equal(canRequestReturn({ status: "paid", fulfillmentStatus: "processing" }), false);
  assert.equal(canRequestReturn({ status: "return_requested", fulfillmentStatus: "shipped" }), false);
}

function testCreatorEarningsSummary() {
  const { summarizeCreatorEarnings } = loadTsModule("lib/creator/earnings.ts");

  const summary = summarizeCreatorEarnings({
    totalVideos: 2,
    totalOrders: 3,
    totalSalesCents: 10_000,
    paidCommissionableCents: 4_000,
    pendingCommissionableCents: 5_000,
    failedCommissionableCents: 1_000,
    blockedCommissionableCents: 0,
    paidItems: 1,
    pendingItems: 2,
    failedItems: 1,
    blockedItems: 0,
    thisMonthSalesCents: 2_500,
    thisMonthOrders: 1,
  });

  assert.equal(summary.earningsCents, 500);
  assert.equal(summary.paidOutCents, 200);
  assert.equal(summary.pendingCents, 250);
  assert.equal(summary.payoutStatus.failedCents, 50);
  assert.equal(summary.analytics.averageOrderCents, 3333);
  assert.equal(summary.analytics.thisMonthEarningsCents, 125);
}

function testSellerRefundPolicy() {
  const { evaluateSellerRefundRequest } = loadTsModule("lib/seller/refund-policy.ts");

  assertJsonEqual(
    evaluateSellerRefundRequest({
      orderStatus: "return_requested",
      totalItems: 2,
      sellerItems: 1,
      paymentIntentId: "pi_123",
      existingRefundId: null,
    }),
    {
      allowed: false,
      code: "multi_seller_requires_admin",
      message: "Comenzile cu produse de la mai multi selleri necesita refund administrativ.",
    },
  );

  assert.equal(
    evaluateSellerRefundRequest({
      orderStatus: "return_requested",
      totalItems: 1,
      sellerItems: 1,
      paymentIntentId: "pi_123",
      existingRefundId: null,
    }).allowed,
    true,
  );

  assert.equal(
    evaluateSellerRefundRequest({
      orderStatus: "refunded",
      totalItems: 1,
      sellerItems: 1,
      paymentIntentId: "pi_123",
      existingRefundId: "re_123",
    }).code,
    "already_refunded",
  );
}

await testStripeWebhookSignatureVerification();
testOrderStatusHelpers();
testCreatorEarningsSummary();
testSellerRefundPolicy();
