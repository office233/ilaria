/**
 * Database connection — pg Pool
 *
 * Uses standard pg.Pool for local/self-hosted PostgreSQL connectivity.
 */

import { Pool } from "pg";
import { logger } from "@/lib/logger";

let pool: Pool | null = null;

/**
 * Plafon de durată per interogare (2026-08-24, audit perf).
 *
 * Fără el, o singură interogare degradată (mat view nerefreshat, plan schimbat
 * după creșterea `feed_events`, autovacuum) putea ocupa o conexiune pe termen
 * nedefinit; cu pool-ul epuizat, cădeau în cascadă și checkout-ul, și
 * autentificarea.
 *
 * Valoarea implicită e deliberat generoasă: scopul e să nu existe blocaje
 * INFINITE, nu să taie interogări lente legitime. Se coboară după ce ai măsurat
 * latențele reale în producție, prin `PG_STATEMENT_TIMEOUT_MS`.
 * Dacă apar 500-uri pe feed imediat după deploy, aici se ridică.
 */
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS) > 0
  ? Math.trunc(Number(process.env.PG_STATEMENT_TIMEOUT_MS))
  : 30_000;

/**
 * Cât așteptăm o conexiune liberă din pool înainte de a arunca
 * "Connection terminated due to connection timeout" (2026-09-24: la cold
 * start — deploy proaspăt, pool gol — primele cereri concurente la
 * /api/products, /api/cron/dispatch-tick, /api/health loveau exact acest
 * plafon). Env-overridable pentru medii mai lente.
 */
const CONNECTION_TIMEOUT_MS = Number(process.env.PG_CONNECTION_TIMEOUT_MS) > 0
  ? Math.trunc(Number(process.env.PG_CONNECTION_TIMEOUT_MS))
  : 10_000;

/**
 * Mărimea pool-ului per replică (2026-09-27, w6-performance). Cu N replici web,
 * totalul N × PG_POOL_MAX (+ workeri, cron, admin) trebuie să rămână sub
 * `max_connections` al serverului Postgres (300 în infra/azure/compose/data.yml)
 * — vezi docs/infra/scaling.md. Peste ~4 replici: PgBouncer în mod transaction.
 */
export function poolSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): { max: number; idleTimeoutMillis: number } {
  const isProd = env.NODE_ENV === "production";
  const rawMax = Number(env.PG_POOL_MAX);
  const rawIdle = Number(env.PG_IDLE_TIMEOUT_MS);
  return {
    max: Number.isInteger(rawMax) && rawMax >= 1 && rawMax <= 200 ? rawMax : isProd ? 15 : 5,
    // 30 s: la trafic în rafale, închiderea după 10 s forța reconectări (TLS/TCP
    // către un server Postgres separat) exact la următorul vârf.
    idleTimeoutMillis: Number.isFinite(rawIdle) && rawIdle >= 1000 ? Math.trunc(rawIdle) : 30_000,
  };
}

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is missing");
  }

  const { max, idleTimeoutMillis } = poolSettingsFromEnv();

  pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis,
    // TCP keep-alive: conexiunile inactive către serverul Postgres separat nu
    // sunt tăiate tăcut de NAT/firewall (altfel prima interogare după o pauză eșuează).
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    // O tranzacție uitată deschisă ține și conexiunea, și locks-urile.
    idle_in_transaction_session_timeout: 30_000,
  });

  // Prevent uncaughtException on FATAL 57P01 (admin shutdown) or idle client errors.
  pool.on("error", (err) => {
    logger.warn({ err }, "[db] idle pg client error");
  });

  return pool;
}

/**
 * `true` doar pentru erori de ACHIZIȚIE a conexiunii (timeout la conectare /
 * "Connection terminated"), NU pentru eșecul unei interogări deja trimise —
 * la cold start (pool gol, prima conexiune la Postgres încă nu s-a stabilit)
 * cererile concurente loveau acest timeout înainte ca vreo interogare să
 * ajungă la server, deci reluarea e sigură (nu poate dubla o scriere).
 */
function isTransientConnectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Connection terminated due to connection timeout") ||
    message.includes("timeout exceeded when trying to connect") ||
    message.includes("Connection terminated unexpectedly")
  );
}

function isSelectOnly(text: string): boolean {
  // A WITH query can hide INSERT/UPDATE/DELETE inside its CTEs, and locking
  // reads/sequence calls have side effects — only plain reads are safe to retry
  // after a dropped connection.
  if (!/^\s*(select|with)\b/i.test(text)) return false;
  return !/\b(insert|update|delete|merge|truncate|nextval|setval|pg_advisory_\w+)\b|\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(
    text,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function dbQuery<T = any>(text: string, params: unknown[] = []) {
  try {
    const result = await getPool().query(text, params);
    return result as { rows: T[]; rowCount: number };
  } catch (err) {
    // Un singur retry, doar pentru SELECT-uri și doar pe eroarea de conectare
    // (vezi isTransientConnectionError) — de regulă cold start, unde pool-ul
    // abia se umple. Nu reîncercăm INSERT/UPDATE/DELETE: dacă eroarea nu e
    // strict de conectare, am putea dubla o scriere.
    if (isSelectOnly(text) && isTransientConnectionError(err)) {
      logger.warn({ err }, "[db] transient connection error on SELECT — retrying once");
      await sleep(150);
      const result = await getPool().query(text, params);
      return result as { rows: T[]; rowCount: number };
    }
    throw err;
  }
}

/**
 * Interogare de mentenanță (REFRESH MATERIALIZED VIEW, backfill, reconciliere):
 * ridică plafonul `statement_timeout` doar pentru conexiunea aceasta. Plafonul
 * implicit al pool-ului e dimensionat pentru cererile utilizatorilor și ar
 * întrerupe legitim o astfel de operație.
 */
export async function dbQueryLong<T = any>(
  text: string,
  params: unknown[] = [],
  timeoutMs = 300_000,
) {
  const client = await getPool().connect();
  try {
    await client.query(`SET statement_timeout = ${Math.trunc(timeoutMs)}`);
    const result = await client.query(text, params);
    return result as { rows: T[]; rowCount: number };
  } finally {
    // Conexiunea se întoarce în pool — plafonul ridicat NU are voie să o urmeze.
    // Restaurăm valoarea explicit, nu prin `DEFAULT`: `DEFAULT` revine la
    // valoarea serverului (tipic 0 = nelimitat), nu la cea configurată de pool,
    // deci ar strecura înapoi în pool o conexiune fără plafon.
    await client
      .query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      .catch(() => undefined);
    client.release();
  }
}

export function getDb() {
  return getPool();
}

/**
 * Rulează `fn` ținând un lock advisory Postgres pe `key` — serializează căile
 * concurente care ating aceeași resursă logică (ex. recreditarea unei
 * aceleiași comenzi din cron ȘI din webhook, care altfel fac ambele
 * check-then-act și creditează de două ori).
 *
 * Lock la nivel de SESIUNE (o conexiune dedicată ținută pe toată durata `fn`),
 * nu de tranzacție — `fn` face mai multe query-uri pe pool, fiecare pe altă
 * conexiune, deci un lock legat de o singură tranzacție nu i-ar acoperi.
 * `pg_advisory_lock`/`unlock` cu aceeași cheie pe conexiunea rezervată.
 */
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  // Cheie stabilă pe 63 biți din `key` (hashtext dă int4; îl folosim ca lock-id).
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
  } catch (err) {
    // Dacă nu putem lua lock-ul, e mai sigur să NU rulăm o operație pe bani
    // fără protecție decât să riscăm dubla execuție.
    client.release();
    throw err;
  }
  try {
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => undefined);
    client.release();
  }
}

/**
 * Semnătura funcției de query primite în callback-ul `withTransaction`.
 * Exportată ca să poată fi tipizate funcțiile care participă la o tranzacție
 * deschisă de apelant.
 */
export type TxQuery = <R = any>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: R[]; rowCount: number }>;

/**
 * Rulează un set de query-uri într-o singură tranzacție.
 * Commit automat la succes, ROLLBACK la orice excepție.
 *
 *   const order = await withTransaction(async (q) => {
 *     const { rows } = await q("INSERT INTO ... RETURNING id", [...]);
 *     await q("UPDATE ... WHERE id = $1", [rows[0].id]);
 *     return rows[0];
 *   });
 */
export async function withTransaction<T>(
  fn: (query: TxQuery) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const query = async <R = any>(text: string, params: unknown[] = []) => {
      const res = await client.query(text, params);
      return res as { rows: R[]; rowCount: number };
    };
    const result = await fn(query);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection may already be dead */
    }
    throw err;
  } finally {
    client.release();
  }
}
