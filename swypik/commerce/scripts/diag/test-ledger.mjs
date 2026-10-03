/**
 * Test ledger monetar — idempotență + corectitudine sold la concurență.
 *
 * Rulare:  node scripts/test-ledger.mjs
 * Cerințe: DATABASE_URL în .env.local (sau env) către o bază cu migrarea
 *          20260730_0002_wallet_ledger_cents.sql aplicată + tabela users.
 *
 * Ce demonstrează:
 *  1. Creditări concurente cu ACELAȘI (ref_type, ref_id): exact o singură
 *     intrare, soldul crește o singură dată (idempotență sub race).
 *  2. Creditări concurente cu ref-uri diferite: soldul = suma exactă
 *     (SELECT FOR UPDATE serializează, nu se pierd update-uri).
 *  3. Debit peste sold → refuzat.
 * Curăță după el (user de test dedicat).
 */
import { readFileSync, existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";

// -- load .env.local (minimal parser, no deps) --
for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const rawLine of readFileSync(f, "utf8").split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL lipsă — configurează .env.local. Test sărit.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

/** Reimplementare 1:1 a logicii din lib/wallet/ledger.ts (nu putem importa TS din .mjs). */
async function applyEntry(kind, { userId, amountCents, refType, refId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT id FROM wallet_ledger_entries WHERE ref_type=$1 AND ref_id=$2 AND kind=$3 LIMIT 1`,
      [refType, refId, kind],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { alreadyApplied: true };
    }
    await client.query(
      `INSERT INTO wallet_balances (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const locked = await client.query(
      `SELECT balance_cents FROM wallet_balances WHERE user_id=$1 FOR UPDATE`,
      [userId],
    );
    const balance = Number(locked.rows[0].balance_cents);
    const delta = kind === "credit" ? amountCents : -amountCents;
    const newBalance = balance + delta;
    if (newBalance < 0) {
      await client.query("ROLLBACK");
      return { error: "insufficient_funds" };
    }
    const ins = await client.query(
      `INSERT INTO wallet_ledger_entries
         (user_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb)
       ON CONFLICT (ref_type, ref_id, kind) DO NOTHING
       RETURNING id`,
      [userId, kind, amountCents, newBalance, refType, refId],
    );
    if (!ins.rows[0]) {
      await client.query("COMMIT");
      return { alreadyApplied: true };
    }
    await client.query(
      `UPDATE wallet_balances SET balance_cents=$2, updated_at=now() WHERE user_id=$1`,
      [userId, newBalance],
    );
    await client.query("COMMIT");
    return { alreadyApplied: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

const email = `ledger-test-${Date.now()}@test.local`;
const { rows: userRows } = await pool.query(
  `INSERT INTO users (email, display_name, username, role)
   VALUES ($1, 'Ledger Test', $2, 'shopper') RETURNING id`,
  [email, `ledgertest_${createHash("md5").update(email).digest("hex").slice(0, 8)}`],
);
const userId = userRows[0].id;
console.log(`Test user: ${userId}`);

try {
  // 1. Idempotență sub concurență: 10 creditări identice simultane
  const ref = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      applyEntry("credit", { userId, amountCents: 500, refType: "test_bonus", refId: ref }),
    ),
  );
  const applied = results.filter((r) => r.alreadyApplied === false).length;
  assert(applied === 1, `10 creditări identice concurente → exact 1 aplicată (a fost ${applied})`);

  let { rows } = await pool.query(
    `SELECT balance_cents FROM wallet_balances WHERE user_id=$1`, [userId]);
  assert(Number(rows[0].balance_cents) === 500, `sold = 500 după creditare idempotentă (e ${rows[0].balance_cents})`);

  // 2. 100 creditări concurente cu ref-uri diferite × 100 cents
  await Promise.all(
    Array.from({ length: 100 }, () =>
      applyEntry("credit", { userId, amountCents: 100, refType: "test_reward", refId: randomUUID() }),
    ),
  );
  ({ rows } = await pool.query(
    `SELECT balance_cents FROM wallet_balances WHERE user_id=$1`, [userId]));
  assert(Number(rows[0].balance_cents) === 10_500, `sold = 10500 după 100 creditări concurente (e ${rows[0].balance_cents})`);

  // 3. Debit valid + debit peste sold
  const d1 = await applyEntry("debit", { userId, amountCents: 2000, refType: "test_spend", refId: randomUUID() });
  assert(d1.alreadyApplied === false, "debit 2000 acceptat");
  const d2 = await applyEntry("debit", { userId, amountCents: 100_000, refType: "test_spend", refId: randomUUID() });
  assert(d2.error === "insufficient_funds", "debit peste sold refuzat");
  ({ rows } = await pool.query(
    `SELECT balance_cents FROM wallet_balances WHERE user_id=$1`, [userId]));
  assert(Number(rows[0].balance_cents) === 8_500, `sold final = 8500 (e ${rows[0].balance_cents})`);

  // 4. Ledger-ul e consistent: sum(credit)-sum(debit) == sold
  ({ rows } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN kind='credit' THEN amount_cents ELSE -amount_cents END),0) AS s
       FROM wallet_ledger_entries WHERE user_id=$1`, [userId]));
  assert(Number(rows[0].s) === 8_500, "suma ledger == sold");
} finally {
  await pool.query(`DELETE FROM users WHERE id=$1`, [userId]); // cascade curăță wallet+ledger
  await pool.end();
}

console.log(process.exitCode ? "\n❌ TESTE EȘUATE" : "\n✅ TOATE TESTELE AU TRECUT");
