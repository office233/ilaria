// node scripts/apply-migration.mjs <file.sql> — aplică o migrare pe DATABASE_URL.
import { readFileSync } from "node:fs";
import pg from "pg";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/apply-migration.mjs <file.sql>"); process.exit(1); }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query(readFileSync(file, "utf8"));
console.log("applied:", file);
await c.end();
