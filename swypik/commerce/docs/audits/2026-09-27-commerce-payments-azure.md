# Commerce and payments: Azure audit, 27 September 2026

Source: `/opt/swypik/builds/mobile-auth-20260927-175259`, working copy `/opt/swypik/work/commerce-payments-20260927` on Azure web1. PC used only as SSH client. No production data/env edits, no real payments/refunds/messages, no deployment by this agent.

## Ready for integration

1. `lib/shop/pricing.ts`: include currency in cart fingerprint. Previously RON and EUR carts at identical numeric prices could reuse the same pending order and PaymentIntent. Existing pending fingerprints become obsolete and will be replaced through the normal checkout flow. Test covers equal totals with different currency.
2. `app/api/webhooks/stripe/_handlers/checkout.ts`: do not fulfill a Checkout Session with unpaid/unknown payment status. Stripe Checkout completion can precede settlement; the guard also covers the alternate Fly fulfillment branch.
3. `app/api/webhooks/stripe/route.ts`: dispatch `checkout.session.async_payment_succeeded` to Checkout handler. Stripe destination must subscribe to this event when payment credentials are configured. Existing signature verification remains over exact raw bytes.
4. Same route: reject requests without signature before reading body, enforce 1 MiB limit using actual streaming bytes as well as Content-Length, release reader and return 413 for oversized requests. This bounds per-request memory even with missing/forged length.

Stripe reference: https://docs.stripe.com/checkout/fulfillment and https://docs.stripe.com/api/checkout/sessions/object . These require checking payment status and supporting delayed success events. No external implementation code copied.

## Validation

Azure Docker node:22-alpine, network disabled, 1 CPU / 768 MiB, single Vitest worker. 51 tests passed in six files:

- tests/unit/stripe-webhook-route.test.ts (new, 8)
- tests/unit/stripe-checkout-settlement.test.ts (new, 4)
- tests/unit/shop-pricing.test.ts (18, including new currency regression)
- tests/unit/checkout-create-intent-route.test.ts (10)
- tests/unit/shop-order-creation.test.ts (5)
- tests/unit/shop-catalog.test.ts (6)

Mocks cover no real DB writes or Stripe requests. Full typecheck/build reserved for root integration. Initial attempts did not run tests: host has no node binary; Vitest v4 rejected obsolete minWorkers option. Actual successful run used Docker and maxWorkers=1/no-file-parallelism.

## Confirmed release blockers and further work

**Do not activate Stripe/live commerce until atomic settlement, crash-safe event processing, terminal-state preservation and replayable fulfillment have been implemented and passed the isolated PostgreSQL failure/concurrency tests below.** The small fixes above do not resolve these structural payment risks.

- Live Stripe secret, webhook secret, publishable key are all placeholders (values not recorded). Real checkout cannot be certified until credentials, event subscription, and sandbox E2E are verified.
- Public catalog query `limit=1&includeCount=1&locale=ro&currency=RON`: total 0, returned 0, source postgresql. Feed `limit=1`: items 0, videos 0, hasMore false. No products or video content were fabricated/imported.
- `payments.ts`: paid status is committed before stock changes. Stock query failures are swallowed. Retry skips the paid transition, so stock/payment transaction/finalization/fulfillment can be lost after intermediate failure. Needs atomic settlement plus replayable post-commit effects.
- Global webhook idempotency inserts the processed event before handler. Process death (not a caught exception) leaves a permanent processed marker, suppressing Stripe retry. A caught failure deletes the claim, but already committed side effects may still be partial. Needs serial execution + completion marker, paired with handler idempotency/outbox (not a claim-only patch).
- Hosted checkout handler selects checkout_sessions FOR UPDATE, but absent rows provide no lock. Distinct concurrently delivered events for the same session can race before session insertion; serialize per session or establish unique claim before order creation. Existing update also sets status paid without preserving terminal refunded/cancelled states; review event ordering/reconciliation before enabling payments.
- Price and variant ownership enforced server-side by shop pricing; pending stock reservations subtracted, duplicated cart lines consume progressive stock. Seller order reads and shipment authorization scoped by seller ID. This is code inspection plus selected unit tests, not complete commerce security certification.

## Proposed next isolated tranche (not implemented here)

Transactional shop settlement: lock order; validate linked PaymentIntent, received amount/currency; lock and update inventory deterministically; persist payment transaction, paid status, reservation/cart state atomically. If funds arrived but inventory is insufficient, persist a fulfillment hold/manual review state; do not falsely report payment failure or ship unavailable stock. Null inventory means untracked, not zero.

Outbox: unique (order_id, effect_kind) records in the same transaction for fulfillment/notifications/referral. Consumers retry idempotently and checkpoint completed effects. External exactly-once delivery requires provider idempotency support; do not claim a database transaction makes email exactly once.

Event completion: serialize per Stripe event and logical Checkout Session using scoped advisory locks; mark processed only after durable settlement/outbox enqueue. Avoid holding a DB transaction during external network work.

Required isolated PostgreSQL tests: concurrent duplicate events; different events same payment/session; rollback injection between paid/stock/transaction writes; crash before/after commit and marker; outbox retry; stock shortage and null stock; payment mismatch; terminal-order replays. Run against a disposable Azure container/database, never production fixtures. Approximately 7–10 code/test files plus migration; integration/deploy should be separate from the small completed fixes.
