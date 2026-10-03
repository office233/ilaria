/**
 * Run ONLY against an isolated, disposable PostgreSQL database named
 * swypik_auth_fixture. No public ports or production credentials required.
 * npx tsx tests/integration/auth-password-reset.ts
 */
import assert from "node:assert/strict";
import { Pool } from "pg";
import { resetPasswordWithToken } from "../../lib/auth/reset-password";

async function main() {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.equal(url.pathname, "/swypik_auth_fixture", "Only the disposable fixture database is allowed");
  assert.equal(url.hostname, "auth-fixture", "Use the isolated Docker fixture host");
  const pool = new Pool({ connectionString: url.toString() });
  try {
    await pool.query(`
      CREATE TABLE users (id text PRIMARY KEY, password_hash text, updated_at timestamptz, totp_backup_codes text[]);
      CREATE TABLE password_reset_tokens (token_hash text PRIMARY KEY, user_id text REFERENCES users(id), expires_at timestamptz, used_at timestamptz);
      CREATE TABLE user_sessions (id text PRIMARY KEY, user_id text REFERENCES users(id), revoked_at timestamptz);
      INSERT INTO users VALUES ('u', 'old', now(), ARRAY['one','two']);
      INSERT INTO password_reset_tokens VALUES ('concurrent', 'u', now() + interval '1 hour', NULL);
      INSERT INTO user_sessions VALUES ('session', 'u', NULL);
    `);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => resetPasswordWithToken("concurrent", "new-" + i)));
    assert.equal(results.filter(Boolean).length, 1, "Exactly one concurrent reset wins");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM user_sessions WHERE revoked_at IS NOT NULL")).rows[0].n, 1);
    assert.equal(await resetPasswordWithToken("concurrent", "replay"), false);

    await pool.query(`
      UPDATE users SET password_hash = 'before-rollback';
      UPDATE user_sessions SET revoked_at = NULL;
      INSERT INTO password_reset_tokens VALUES ('rollback', 'u', now() + interval '1 hour', NULL);
      CREATE FUNCTION reject_session_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture revocation failure'; END $$;
      CREATE TRIGGER fail_revoke BEFORE UPDATE ON user_sessions FOR EACH ROW EXECUTE FUNCTION reject_session_update();
    `);
    await assert.rejects(resetPasswordWithToken("rollback", "must-not-persist"), /fixture revocation failure/);
    assert.equal((await pool.query("SELECT password_hash FROM users WHERE id='u'")).rows[0].password_hash, "before-rollback");
    assert.equal((await pool.query("SELECT used_at FROM password_reset_tokens WHERE token_hash='rollback'")).rows[0].used_at, null);
    await pool.query("DROP TRIGGER fail_revoke ON user_sessions");
    assert.equal(await resetPasswordWithToken("rollback", "recovered"), true);
    await pool.query("INSERT INTO password_reset_tokens VALUES ('expired', 'u', now() - interval '1 minute', NULL)");
    assert.equal(await resetPasswordWithToken("expired", "never"), false);

    const backup = () => pool.query(
      "UPDATE users SET totp_backup_codes = $1 WHERE id = $2 AND totp_backup_codes = $3 RETURNING id",
      [["two"], "u", ["one", "two"]],
    );
    const backupResults = await Promise.all(Array.from({ length: 8 }, backup));
    assert.equal(backupResults.filter((r) => r.rowCount === 1).length, 1);
    console.log("PASS: concurrent reset, replay, expiry, rollback, retry, concurrent backup-code CAS");
  } finally {
    await pool.end();
  }
}
main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
