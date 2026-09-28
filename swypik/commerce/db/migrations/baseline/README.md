# Baseline Migration Stubs

This directory contains **inert** stub files for database migrations that were
applied to the production database **before** the corresponding migration files
were retained in this repository. They exist so that
[`tools/check-migration-drift.sh`](../../../tools/check-migration-drift.sh) can
verify that every version in `schema_migrations` has either:

1. A real, executable migration file under `db/migrations/`, **or**
2. A baseline stub in this directory (this folder).

## Naming convention

Each stub is named `<version>.applied.sql`. The `.applied` suffix marks the file
as an audit-only marker that **must never be executed**.

## Why this exists

When the project was migrated from earlier infra into the current monorepo
layout, the migration runner had already recorded ~15 historical versions. The
original SQL was either:

- destructive/idempotent and folded into newer migrations,
- emitted by hand on the VPS, or
- recovered from a `pg_dump` and superseded by current schema.

Re-running them today would either be a no-op or actively harmful (some recreate
columns that have since been dropped/renamed). The authoritative snapshot of
the current schema is [`db/schema.sql`](../../schema.sql), regenerated via
`pg_dump --schema-only` on every release.

## Rules

- **Never** add executable SQL to a `.applied.sql` file.
- **Never** delete a baseline stub without first verifying that the version no
  longer appears in `schema_migrations`.
- New migrations always go to `db/migrations/` with date prefix `YYYYMMDD_NNNN`.
- After applying a new migration, regenerate `db/schema.sql`:
  ```sh
  docker exec -i swypik-prod-postgres-1 pg_dump -U swypik -d swypik \
    --schema-only --no-owner --no-privileges --no-comments \
    > db/schema.sql
  ```

## Audit

To verify the repo is in sync with the live DB:

```sh
bash tools/check-migration-drift.sh
```

Expected output:

```
── Swypik migration audit ──
  applied in DB         : 103
  files in db/migrations: 89
  baseline stubs        : 15
  total accounted-for   : 104
OK: 0 drift ...
```

(Note `total accounted-for` may be `applied + 1` if a brand-new migration file
exists on disk and has just been applied — drift check will still pass.)
