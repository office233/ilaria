// Explicit local WSL/PostgreSQL test; never reads application credentials or production data.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const schema = `auth_pilot_${Date.now()}`;
const sql = readFileSync(new URL('../../lib/auth/rotate-bearer.ts', import.meta.url), 'utf8').split('`')[1];
function run(statement) {
 return new Promise((resolve, reject) => {
  const p = spawn('wsl.exe',['-d','swypik','--exec','docker','exec','-i','swypik-prod-postgres-1','psql','-U','swypik','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],{windowsHide:true});
  let out='',error='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>error+=d);
  p.on('error',reject);p.on('close',code=>code===0?resolve(out.trim()):reject(new Error(error)));
  p.stdin.end(`SET search_path TO ${schema}; SET statement_timeout='15s';\n${statement}`);
 });
}
const prepare = `PREPARE rotate(text,text,text,jsonb) AS ${sql};`;
try {
 await run(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
 CREATE TABLE users(id text PRIMARY KEY,status text,suspended_until timestamptz);
 CREATE TABLE user_sessions(id bigint GENERATED ALWAYS AS IDENTITY,user_id text REFERENCES users(id),session_token_hash text UNIQUE,kind text,user_agent text,expires_at timestamptz,metadata jsonb,revoked_at timestamptz);
 INSERT INTO users VALUES('u','active',NULL);
 INSERT INTO user_sessions(user_id,session_token_hash,kind,expires_at) VALUES('u','old','bearer',now()+interval '1 day');`);
 const first=run(`${prepare} BEGIN; EXECUTE rotate('old','next_a','test','{}'); SELECT pg_sleep(2); COMMIT;`);
 const second=run(`${prepare} EXECUTE rotate('old','next_b','test','{}');`);
 await Promise.all([first,second]);
 assert.equal(await run("SELECT count(*) FROM user_sessions WHERE revoked_at IS NULL;"),'1');
 assert.equal(await run("SELECT count(*) FROM user_sessions WHERE session_token_hash='old' AND revoked_at IS NOT NULL;"),'1');
 console.log('PASS: concurrent refresh creates exactly one successor');
 await run("INSERT INTO user_sessions(user_id,session_token_hash,kind,expires_at) VALUES('u','rollback_old','bearer',now()+interval '1 day');");
 await assert.rejects(run(`${prepare} EXECUTE rotate('rollback_old','old','test','{}');`),/duplicate key/);
 assert.equal(await run("SELECT count(*) FROM user_sessions WHERE session_token_hash='rollback_old' AND revoked_at IS NULL;"),'1');
 console.log('PASS: failed insert rolls back token consumption');
 for (const policy of ["status='banned'","status='suspended'","status='deleted'","status='active',suspended_until=now()+interval '1 day'"]) {
  await run(`UPDATE users SET suspended_until=NULL; UPDATE users SET ${policy};`);
  assert.equal(await run(`${prepare} EXECUTE rotate('rollback_old','blocked','test','{}');`),'');
 }
 console.log('PASS: restricted accounts cannot rotate');
} finally {
 // This schema contains only fixtures created by this test in the local postgres database.
 await run(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
}
