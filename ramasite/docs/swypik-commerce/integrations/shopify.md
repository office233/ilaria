# Shopify seller migration — Swypik

This integration is owned by the Swypik seller portal at `https://swypik.com/seller`.

## Ownership model

Each Swypik seller connects their own Shopify store.

A connection is scoped to:
- one Swypik `seller_id`;
- one canonical `*.myshopify.com` domain;
- that store's encrypted OAuth credentials;
- independent catalog, customer and order cursors;
- independent webhook/reconciliation state.

The database prevents the same external store from being attached to two Swypik sellers.

## Public URLs

Seller entry points:
- `https://swypik.com/seller`
- `https://swypik.com/seller/integrations`

OAuth:
- start: `https://swypik.com/api/seller/integrations/shopify/start?shop=<store>.myshopify.com`
- callback: `https://swypik.com/api/seller/integrations/shopify/callback`

Shop-specific operational webhook:
- `https://swypik.com/api/webhooks/commerce/shopify`

Mandatory Shopify privacy webhooks:
- `https://swypik.com/api/webhooks/commerce/shopify/customers-data-request`
- `https://swypik.com/api/webhooks/commerce/shopify/customers-redact`
- `https://swypik.com/api/webhooks/commerce/shopify/shop-redact`

## Required runtime configuration

```env
SHOPIFY_API_VERSION=2026-07
SHOPIFY_CLIENT_ID=<Shopify app client id>
SHOPIFY_CLIENT_SECRET=<Shopify app client secret>
SHOPIFY_OAUTH_SCOPES=read_products,read_customers,read_orders
SHOPIFY_OAUTH_HTTP_TIMEOUT_MS=20000
```

For complete order history beyond the normal order-history window, request Shopify approval for `read_all_orders` and then add it to `SHOPIFY_OAUTH_SCOPES`.

Do not put access tokens, refresh tokens, merchant secrets or store-specific credentials in environment variables. Store credentials are encrypted per seller/store in `seller_catalog_integrations.credentials_enc`.

## Shopify app configuration

Use the settings in `shopify.app.toml.example` as the production contract.

Important:
- the app is standalone/offsite, so `embedded = false`;
- register the callback URL exactly;
- mandatory privacy topics are app configuration, not shop-specific GraphQL subscriptions;
- deploy Shopify app configuration changes before App Store review.

## Flow

1. Seller signs in to Swypik and opens `/seller`.
2. Seller chooses store migration and opens `/seller/integrations`.
3. Seller enters only their canonical `store.myshopify.com` domain.
4. Swypik creates one-time OAuth state bound to that `seller_id + shop`.
5. Browser is redirected to Shopify.
6. Merchant approves requested scopes.
7. Shopify redirects to Swypik callback.
8. Swypik validates HMAC and consumes one-time state.
9. Swypik exchanges the code for an expiring offline token + refresh token.
10. Credentials are encrypted and bound to the seller/store.
11. The minute integration worker configures operational webhooks.
12. Reconciliation bootstraps catalog, customers and historical orders.
13. Webhooks keep changed resources current.
14. Periodic reconciliation repairs missed/out-of-order deliveries.
15. Token refresh is serialized per integration and persisted automatically.

## Security properties

- OAuth state is random, hashed in PostgreSQL, single-use and expires after 10 minutes.
- Callback HMAC is checked before OAuth state is consumed.
- Store host is restricted to canonical `*.myshopify.com`.
- External credentials never reach the browser after authorization.
- Access/refresh tokens are encrypted with AES-256-GCM using purpose-separated keys.
- Refresh-token rotation is serialized with a PostgreSQL advisory lock.
- Webhook HMAC is checked against the raw request body.
- Duplicate webhook deliveries are ignored idempotently.
- Webhook work runs outside the request through a persistent PostgreSQL queue.
- Imported historical orders stay outside `commerce_orders` and therefore cannot trigger Swypik fulfillment/payout flows.
- `app/uninstalled` deletes live Shopify credentials while preserving historical imported records until Shopify's privacy lifecycle requires redaction.
- Mandatory privacy callbacks return HTTP 401 on invalid HMAC.

## Data privacy behavior

`customers/data_request`:
- records a due/audit request without persisting email or phone from the webhook payload.

`customers/redact`:
- removes the imported CRM customer;
- removes imported customer name/email/phone/external identifier from historical imported orders;
- does not mutate native Swypik `commerce_orders`.

`shop/redact`:
- removes Shopify-imported CRM data;
- removes Shopify-imported marketplace products;
- removes Shopify-imported historical orders;
- deletes the store integration and OAuth state;
- retains only a minimal compliance audit record.

## Operations

Cron job:
- `seller-integration-sync`
- interval: 60 seconds

Admin health:
- `/admin/health`
- card: Commerce sync

The health check exposes:
- pending/failed/processing webhook work;
- expired leases;
- active/degraded/unavailable integrations;
- last successful integration cron run;
- cron age.

Manual seller sync remains available as an operational fallback, but OAuth-connected stores should normally require no manual synchronization.
