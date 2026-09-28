/**
 * Aplică o migrare SQL pe DATABASE_URL local (dev), într-o singură tranzacție,
 * cu înregistrare în schema_migrations (același contract ca scriptul bash de prod).
 *   npx tsx scripts/apply-migration-local.ts db/migrations/XXX.sql
 */
import { readFileSync } from "fs";
import { basename } from "path";
import { Pool } from "pg";

async function main() {
    const file = process.argv[2];
    if (!file) { console.error("Usage: tsx scripts/apply-migration-local.ts <file.sql>"); process.exit(1); }
    const version = basename(file).replace(/\.sql$/, "");
    const sql = readFileSync(file, "utf8");

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
        const done = await client.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [version]);
        if (done.rows.length) { console.log(`SKIP: ${version} already applied`); return; }
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
        await client.query("COMMIT");
        console.log(`OK: ${version} applied`);
    } catch (e) {
        await client.query("ROLLBACK").catch(() => { });
        console.error(`FAIL: ${version}:`, (e as Error).message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}
main();
