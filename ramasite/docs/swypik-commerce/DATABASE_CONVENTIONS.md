# Database Conventions

This document maps the **logical names** referenced in product specs (MVP plan, master plan)
to the **actual table names** in production. We did NOT rename tables to avoid touching
dozens of queries — instead, this document is the canonical mapping.

> Source of truth: `db/schema.sql` (regenerated via `pg_dump --schema-only`).

## Table name mapping (spec → actual)

| Spec / logical name | Actual table(s) | Notes |
|---|---|---|
| `products` | `marketplace_products` (live, ~14k rows), `ae_products` (raw AliExpress staging) | Code reads/writes `marketplace_products` for everything user-facing. `ae_products` is import staging only. |
| `product_variants` | `marketplace_product_variants`, `ae_variants` | Same split as products. |
| `orders` | `commerce_orders` | The bare name `orders` was never used. |
| `order_items` | `commerce_order_items` | Includes `payout_status` CHECK constraint (migration 20260514_0003). |
| `collections` (user saves) | `creator_collections`, `user_collections` | Currently both empty. Need to confirm which is canonical for the user-saves feature; pick one before MVP launch. |
| `collection_items` | `creator_collection_items`, `user_collection_items` | Both empty — see above. |
| `wallet` / `swyp_points` | `swyp_wallets` + `wallet_transactions` | Both empty. |
| `challenges` | `daily_challenges`, `challenge_entries` | Both empty — Faza E will seed. |
| `creator_points` | `commissions` + `connect_transfers` (creators paid via commissions, not a points table) | Audit found `creator_points` table doesn't exist; the actual mechanism is commissions. |

## Auth fragmentation (4 tables)

The platform currently has **4 separate auth tables**, a known gap to be unified in Faza K.

| Table | Purpose | Rows | Status |
|---|---|---|---|
| `users` | Original / social-side users | 9 | Has data integrity issues: 5 rows with empty email |
| `customers` | Commerce-side buyers | 5 | All emails present |
| `sellers` | Marketplace sellers | 0 | Empty (no production sellers yet) |
| `auth_accounts` | Future consolidation target | 0 | Empty (Faza K will populate) |

**Email overlap**: 3 emails appear in both `users` and `customers`:
`audit@test.com`, `test@swypik.com`, `vargaabel12@gmail.com`.

These are NOT cleaned up yet — they will be merged when Faza K runs the auth-unify migration.

## Things tagged for cleanup (DEFERRED to Faza K)
- 5 rows in `users` with empty/blank email — investigate whether they have any owned data (videos, comments, etc.) before deletion (see `AUTH_USER_DUPLICATES.md`)
- 3 email overlaps users∩customers — pick one canonical record per email when migrating to `auth_accounts`

## Migration tracking

Source of truth: `schema_migrations` table in DB (17 rows, matches the 17 .sql files in `db/migrations/`).
Naming convention: `YYYYMMDD_NNNN_description.sql` — strict, no collisions.
