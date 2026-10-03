/** Aplica migrarile date ca argumente pe DATABASE_URL din .env.local (dev only). */
import { readFileSync, existsSync } from "node:fs";
import pg from "pg";

for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const rawLine of readFileSync(f, "utf8").split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
for (const file of process.argv.slice(2)) {
  try {
    await pool.query(readFileSync(file, "utf8"));
    console.log("OK ", file);
  } catch (err) {
    console.log("ERR", file, err.message);
    await pool.query("ROLLBACK").catch(() => {});
  }
}
await pool.end();
