import pg from 'pg';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL, max:3, connectionTimeoutMillis:10000});
const schema = 'swypik_auth_check_' + Date.now();
const sql = readFileSync('/app/lib/auth/rotate-bearer.ts','utf8').split('`')[1];
const admin=await pool.connect();
try {
 const cols=await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name IN ('status','suspended_until')");
 assert.equal(cols.rows.length,2);
 await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}; CREATE TABLE users(id text PRIMARY KEY,status text,suspended_until timestamptz); CREATE TABLE user_sessions(id bigint GENERATED ALWAYS AS IDENTITY,user_id text REFERENCES users(id),session_token_hash text UNIQUE,kind text,user_agent text,expires_at timestamptz,metadata jsonb,revoked_at timestamptz); INSERT INTO users VALUES('fixture','active',NULL); INSERT INTO user_sessions(user_id,session_token_hash,kind,expires_at) VALUES('fixture','old','bearer',now()+interval '1 day')`);
 const a=await pool.connect(), b=await pool.connect();
 try {
  await a.query(`SET search_path TO ${schema}`); await b.query(`SET search_path TO ${schema}`);
  const outcomes=await Promise.all([a.query(sql,['old','a','fixture','{}']),b.query(sql,['old','b','fixture','{}'])]);
  assert.equal(outcomes.reduce((n,r)=>n+r.rowCount,0),1);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM user_sessions WHERE revoked_at IS NULL')).rows[0].n,1);
  console.log('PASS Azure PostgreSQL: concurrent refresh has one successor');
  await admin.query("INSERT INTO user_sessions(user_id,session_token_hash,kind,expires_at) VALUES('fixture','rollback','bearer',now()+interval '1 day')");
  await assert.rejects(admin.query(sql,['rollback','old','fixture','{}']),e=>e.code==='23505');
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM user_sessions WHERE session_token_hash='rollback' AND revoked_at IS NULL")).rows[0].n,1);
  console.log('PASS Azure PostgreSQL: insertion error rolls back consumption');
  for (const policy of ["status='banned'","status='suspended'","status='deleted'","status='active',suspended_until=now()+interval '1 day'"]) {
   await admin.query(`UPDATE users SET suspended_until=NULL; UPDATE users SET ${policy}`);
   assert.equal((await admin.query(sql,['rollback','blocked','fixture','{}'])).rowCount,0);
  }
  console.log('PASS Azure PostgreSQL: restricted accounts cannot refresh');
 } finally {a.release();b.release();}
} finally {
 await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
 admin.release();await pool.end();
}
