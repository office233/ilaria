# Auth User Duplicates — Investigation Report

> Generated 2026-05-13. Status: **investigated, not cleaned**. Cleanup deferred to Faza K (auth unification).

## 1. Empty-email rows in `users` (5 rows)

Data ownership counts (videos.creator_id, comments.user_id, likes.user_id, follows.follower_user_id OR following_user_id, feed_events.actor_user_id):

| user_id (short) | username | created_at | owns_data? | recommendation |
|---|---|---|---|---|
| `00000000…0001` | `swypik-admin` | 2026-05-12 08:53 | none (0/0/0/0/0) | KEEP — system/seed admin row, give it a real email in Faza K (`admin@swypik.com`) |
| `44b79480…be28` | `anon_44b794802632452f` | 2026-05-12 13:24 | yes — 1 like, 6 feed_events | KEEP, leave as anonymous in Faza K migration (cannot merge into `auth_accounts` without an email) |
| `b4bd4900…fd48…5a` | `anon_b4bd4900372740aa` | 2026-05-13 15:23 | none (0/0/0/0/0) | DELETE in Faza K cleanup (no owned data) |
| `b63607fd…1f16` | `anon_b63607fd85554814` | 2026-05-13 15:23 | none (0/0/0/0/0) | DELETE in Faza K cleanup (no owned data) |
| `70461a1b…c0d2` | `anon_70461a1bfd7d41d7` | 2026-05-13 15:23 | none (0/0/0/0/0) | DELETE in Faza K cleanup (no owned data) |

Net effect of Faza K cleanup: 1 row migrated (admin, after email assignment), 1 retained as anonymous, 3 deleted.

## 2. Overlapping emails users∩customers (3 emails)

In every overlap, the `customers` row was created **first** (May 11) and the `users` row was created later (May 12+). Both reference the same human; the customers row is the order-side record, the users row is the social-side record.

| email | users.id | users.created | customers.id | customers.created | likely canonical |
|---|---|---|---|---|---|
| `audit@test.com` | `6a7d843b…0a60` | 2026-05-12 13:32 | `d9a0f88c…0c52` | 2026-05-11 11:07 | merge into single `auth_accounts` row; preserve both legacy ids in `auth_accounts.metadata` for FK rewiring |
| `test@swypik.com` | `87156efc…81f4` | 2026-05-12 13:21 | `f6dd7d4a…0faf` | 2026-05-11 10:12 | merge — same as above |
| `vargaabel12@gmail.com` | `8281f4c1…5894` | 2026-05-12 15:50 | `a8eea5ed…4a42` | 2026-05-11 14:48 | merge — same as above (real user, not a test) |

## Recommended Faza K migration steps

1. Backfill an email for the seed admin row (`00000000-…-0001`) — e.g., `admin@swypik.com`.
2. For each empty-email anon row with no owned data (3 rows): hard delete.
3. For the one anon row with activity (1 like, 6 feed_events): retain in `users`, do NOT create an `auth_accounts` entry (keep as anonymous attribution).
4. For the 3 overlap emails: create one `auth_accounts` row per email, link to both legacy ids via `auth_accounts.metadata.legacy_user_id` and `auth_accounts.metadata.legacy_customer_id`.
5. Rewire FKs: rewrite all `*.user_id` referencing the legacy `users.id` and all `*.customer_id` referencing the legacy `customers.id` to the new `auth_accounts.id` in a single transaction.
6. Add a uniqueness check: after migration, `lower(email)` must be unique across `auth_accounts` (the partial unique index on `users.email` is already there — port the same pattern).
7. Keep `users` and `customers` tables as views over `auth_accounts` for one release to avoid breaking unmigrated read paths.
