import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "../functions/api/waitlist.ts";

function database(changes = 1) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...values) {
          calls.push({ sql, values });
          return { run: async () => ({ success: true, meta: { changes } }) };
        },
      };
    },
  };
}

async function send(body, { db = database(), headers = {}, method = "POST" } = {}) {
  const request = new Request("https://site.example.test/api/waitlist", {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  return onRequest({ request, env: { DB: db } });
}

test("normalizes email, requires consent and stores only bound parameters", async () => {
  const db = database();
  const response = await send({ email: " Person@Example.test ", consent: true }, { db });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, existing: false });
  assert.equal(db.calls[0].values[1], "person@example.test");
  assert.equal(db.calls[0].values[2], "homepage");
  assert.match(db.calls[0].sql, /VALUES \(\?1, \?2, \?3/);
});

test("duplicate signup is idempotent", async () => {
  const response = await send({ email: "person@example.test", consent: true }, { db: database(0) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, existing: true });
});

test("rejects null, arrays, primitives, invalid JSON and missing consent", async () => {
  for (const body of [null, [], 42, '"string"', "{bad", { email: "person@example.test" }, { email: 42, consent: true }, { email: "person@example.test", consent: true, company: {} }]) {
    const db = database();
    assert.equal((await send(body, { db })).status, 400);
    assert.equal(db.calls.length, 0);
  }
});

test("honeypot never accesses the database", async () => {
  const db = database();
  assert.equal((await send({ company: "bot" }, { db })).status, 200);
  assert.equal(db.calls.length, 0);
});

test("checks actual bytes with missing or understated Content-Length", async () => {
  const body = JSON.stringify({ email: "person@example.test", consent: true, source: "x".repeat(4096) });
  for (const headers of [{}, { "content-length": "1" }, { "content-length": "99999" }]) {
    const db = database();
    assert.equal((await send(body, { db, headers })).status, 413);
    assert.equal(db.calls.length, 0);
  }
});

test("caps UTF-8 bytes rather than character count", async () => {
  const body = JSON.stringify({ email: "person@example.test", consent: true, source: "é".repeat(2500) });
  assert.ok(body.length < 4096);
  assert.equal((await send(body)).status, 413);
});

test("requires POST and the exact JSON media type", async () => {
  const response = await send(null, { method: "GET" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal((await send({}, { headers: { "content-type": "text/plain; application/json" } })).status, 415);
});

test("database failure returns controlled JSON without leaking details", async () => {
  const db = { prepare() { throw new Error("database credentials must stay private"); } };
  const response = await send({ email: "person@example.test", consent: true }, { db });
  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.ok(!(await response.text()).includes("credentials"));
});
