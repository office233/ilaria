# Database Migrations

## How to apply a migration on production

```bash
# From /opt/swypik/app on the VPS
./scripts/db/apply-migration.sh db/migrations/YYYYMMDD_NNNN_short_name.sql
```

The script runs the SQL inside a transaction together with the
`INSERT INTO schema_migrations` row, so a failure rolls back both.
It is also idempotent: rerunning with an already-applied version is a no-op.

## Conventions

- Filename: `YYYYMMDD_NNNN_short_name.sql` (e.g. `20260518_0006_pricing_markup.sql`)
- The version stored in `schema_migrations.version` is the filename **without** `.sql`.
- Each migration **must be idempotent** (use `IF NOT EXISTS`, `CREATE OR REPLACE`,
  `DO $$ ... $$` guards, etc.).
- One logical change per migration. Keep them small and reviewable.

## Keeping `db/schema.sql` in sync (schema drift)

`db/schema.sql` is **a mirror, not the source of truth**. The source of truth is
the live database; the file exists so schema can be read and reviewed without DB
access.

It once went ~4 months stale — missing 69 tables (the entire SWYP subsystem,
mobility, travel, platform) while still containing 5 tables already dropped by
`20260731_0001` and `20260801_0001`. Two consecutive audits reasoned off it and
reported columns that did not exist while missing columns that did. Do not
analyse schema from this file without checking it is current.

**After applying any migration to production, re-sync:**

```bash
# from swypik/app, on a machine with access to the prod DB (WSL distro `swypik`)
bash scripts/db/check-schema-drift.sh          # verify only; exit 1 on drift
bash scripts/db/check-schema-drift.sh --write  # regenerate db/schema.sql
git diff --stat db/schema.sql                  # review before committing
```

The script is **read-only against production** (`pg_dump --schema-only`). It
normalises away the `\restrict` token and the `Dumped by/from` version lines,
which change on every run without reflecting a real schema change — otherwise
every regeneration would produce a noisy diff.

Overridable via env: `PG_CONTAINER`, `PG_USER`, `PG_DB`.

**Not wired into CI**: the CI runner has no access to the production database.
Run it manually after each migration batch.

## Notes on legacy records

The `schema_migrations` table contains ~22 historical entries whose SQL files
were deleted/renamed before this convention was enforced. They are harmless
and intentionally left in place to preserve the audit trail. Do **not** delete
or renumber them.

## On `docker-entrypoint-initdb.d`

The compose file mounts `db/migrations/` into the postgres container's
`/docker-entrypoint-initdb.d` directory. **This only runs on first init of an
empty data volume** — for an existing production database it is a no-op.
Always use `apply-migration.sh` (or equivalent transactional flow) for new
migrations on live data.
