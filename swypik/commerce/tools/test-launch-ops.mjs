import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.ok(existsSync(absolutePath), `${relativePath} should exist`);
  return readFileSync(absolutePath, "utf8");
}

function assertIncludesAll(label, text, values) {
  for (const value of values) {
    assert.ok(text.includes(value), `${label} should include ${value}`);
  }
}

const smoke = read("infra/hetzner/smoke-test.sh");
assertIncludesAll("smoke test", smoke, [
  "WEB_BASE_URL",
  "API_BASE_URL",
  "/api/health",
  "/healthz",
  "/readyz",
  "/explore",
  "/account",
  "/creator/upload",
  "/seller",
  "/admin",
  "/api/explore/feed?limit=1",
  "/api/creator/upload-session",
  "/api/seller/dashboard",
  "/api/admin/marketplace",
  "/api/checkout",
  "/api/checkout/create-intent",
  "/api/webhooks/stripe",
  "/v1/videos/uploads/init",
  "SMOKE_PRODUCT_ID",
]);
assert.match(smoke, /products"\s*:\s*\[\]/, "checkout smoke should use an empty cart, not a real payment");
assert.match(smoke, /expected status/i, "smoke test should print status expectations");

const harden = read("infra/hetzner/harden-permissions.sh");
assertIncludesAll("hardening script", harden, [
  "APP_DIR",
  "chmod 750",
  ".env.production",
  "chmod 640",
  "chmod o-w",
  "backup-postgres.sh",
]);
assert.doesNotMatch(harden, /\brm\s+-rf\b/, "hardening script should not recursively delete files");

const stripeWebhook = read("app/api/webhooks/stripe/route.ts");
assertIncludesAll("Stripe webhook route", stripeWebhook, [
  "logCheckoutEvent",
  "webhook_fail",
  "Signature verification failed",
  "Webhook handler failed",
]);

const checklist = read("docs/ops/LAUNCH_CHECKLIST.md");
assertIncludesAll("launch checklist", checklist, [
  "SENTRY_DSN",
  "SENTRY_ENVIRONMENT",
  "Cloudflare uptime monitor",
  "https://swypik.com/api/health",
  "https://api.swypik.com/healthz",
  "https://api.swypik.com/readyz",
  "Stripe webhook",
  "backup-postgres.sh",
  "rate limit",
  "file validation",
  "audit log",
]);

console.log("launch ops checks passed");
