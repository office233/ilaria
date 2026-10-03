import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { AuthController, createAuthApi } from '../src/lib/auth-core.ts';
import { IlariaClient } from '../src/lib/ilaria-api.ts';
import { strictJSON, type CorticalRequest } from '../src/lib/ilaria-wire.ts';
import { controlResponse, inferenceResponse } from './fixtures/ilaria.ts';

// Real loopback HTTP with synthetic auth and worker activity, not a model/runtime proof.
async function gateway(t: TestContext, mode: 'success' | 'pending' | 'malformed' | 'offline') {
  const requests: { path: string; body: CorticalRequest; raw: string }[] = [];
  const errors: unknown[] = [];
  const active = new Map<string, { timer: ReturnType<typeof setInterval>; response: ServerResponse }>();
  let ticks = 0;
  let confirmStop = true;
  let received!: () => void;
  const inferenceReceived = new Promise<void>(resolve => { received = resolve; });
  const send = (response: ServerResponse, body: unknown) => {
    const text = JSON.stringify(body);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    response.end(text);
  };
  const stop = (id: string) => {
    const worker = active.get(id);
    if (!worker) return;
    clearInterval(worker.timer); worker.response.destroy(); active.delete(id);
  };
  const token = 'a'.repeat(64);
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers.accept, 'application/json');
      if (request.url === '/api/auth/token') {
        send(response, { success: true, access_token: token, expires_at: '2030-01-01T00:00:00Z' }); return;
      }
      assert.equal(request.headers.authorization, 'Bearer ' + token);
      if (request.url === '/api/auth/me') {
        send(response, { ok: true, user: { userId: 'fixture-user', role: 'shopper', email: null, displayName: null } }); return;
      }
      if (request.url === '/api/auth/token/revoke') {
        send(response, { success: true }); return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['content-type'], 'application/json');
      assert.ok(['/api/ilaria/infer', '/api/ilaria/cancel'].includes(request.url ?? ''));
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = strictJSON(raw) as CorticalRequest;
      assert.equal(body.initiator, 'fixture-user');
      assert.deepEqual(body.constraints, ['no_training', 'no_tools']);
      requests.push({ path: request.url!, body, raw });
      if (request.url === '/api/ilaria/cancel') {
        if (confirmStop) stop(body.task_id);
        send(response, controlResponse(body.task_id, confirmStop ? 'stopped' : 'uncertain')); return;
      }
      if (mode === 'success') {
        send(response, inferenceResponse(body.task_id)); received(); return;
      }
      active.set(body.task_id, { timer: setInterval(() => { ticks++; }, 5), response });
      if (mode === 'malformed') send(response, {});
      if (mode === 'offline') response.destroy();
      received();
    } catch (error) {
      errors.push(error);
      response.statusCode = 500; response.end('synthetic fixture failed');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const id of active.keys()) stop(id);
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await closed;
    assert.deepEqual(errors, []);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const transport: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://auth.example.test');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
  };
  const auth = new AuthController(createAuthApi({ enabled: true, origin: 'https://auth.example.test' }, transport),
    { async read() { return null; }, async write() {} }, true);
  await auth.signIn('fixture@example.test', 'synthetic-password');
  assert.equal(auth.getState().status, 'authenticated');
  const client = new IlariaClient(auth, () => {}, transport);
  t.after(async () => { client.close(); await client.cancel(); });
  client.setForeground(true); client.setRemoteConsent(true);
  return { auth, client, requests, inferenceReceived, active, getTicks: () => ticks,
    setConfirmation: (value: boolean) => { confirmStop = value; } };
}

test('HTTP auth -> canonical request -> bounded correlated response has no training or OS authority', { timeout: 10000 }, async t => {
  const fixture = await gateway(t, 'success');
  await fixture.client.start('public synthetic question');
  assert.equal(fixture.client.getState().status, 'succeeded');
  assert.match(fixture.client.getState().message, /canary/);
  assert.equal(fixture.client.getState().response?.hypothesis, 'fixture answer');
  assert.equal(fixture.requests.length, 1);
  const body = fixture.requests[0].body;
  assert.equal(body.goal, 'public synthetic question');
  assert.equal(body.requested_role, 'inference');
  assert.equal(body.privacy_class, 'LOCAL_PRIVATE');
  assert.deepEqual(body.hippocampus_refs, []);
  assert.deepEqual(body.tool_observations, []);
  assert.equal(fixture.active.size, 0);
});

for (const event of ['background', 'consent', 'logout', 'unmount'] as const) {
  test('HTTP cancellation stops owned fixture activity after ' + event, { timeout: 10000 }, async t => {
    const fixture = await gateway(t, 'pending');
    const running = fixture.client.start('public synthetic question');
    await fixture.inferenceReceived;
    if (event === 'background') fixture.client.setForeground(false);
    if (event === 'consent') fixture.client.setRemoteConsent(false);
    if (event === 'logout') await fixture.auth.signOut();
    if (event === 'unmount') fixture.client.close();
    await fixture.client.cancel(); await running;
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests[1].path, '/api/ilaria/cancel');
    assert.equal(fixture.requests[0].raw, fixture.requests[1].raw);
    assert.equal(fixture.active.size, 0);
    const ticks = fixture.getTicks();
    await delay(30);
    assert.equal(fixture.getTicks(), ticks, 'no residual owned fixture activity after acknowledgement');
    assert.equal(fixture.client.getState().response, null);
    assert.ok(['stopped', 'parked'].includes(fixture.client.getState().status));
  });
}

for (const mode of ['malformed', 'offline'] as const) {
  test('HTTP ' + mode + ' response does not abandon remote work or switch models', { timeout: 10000 }, async t => {
    const fixture = await gateway(t, mode);
    await fixture.client.start('public synthetic question');
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.active.size, 0);
    assert.equal(fixture.client.getState().status, mode === 'offline' ? 'offline' : 'error');
    assert.equal(fixture.client.getState().response, null);
  });
}

test('HTTP uncertainty blocks new requests until owned task is explicitly reconciled', { timeout: 10000 }, async t => {
  const fixture = await gateway(t, 'pending');
  fixture.setConfirmation(false);
  const running = fixture.client.start('public synthetic question');
  await fixture.inferenceReceived;
  await fixture.client.cancel(); await running;
  assert.equal(fixture.active.size, 1);
  assert.equal(fixture.client.getState().status, 'uncertain');
  await fixture.client.start('must not be sent');
  assert.equal(fixture.requests.length, 2);
  fixture.setConfirmation(true);
  await fixture.client.cancel();
  assert.equal(fixture.active.size, 0);
  assert.equal(fixture.client.getState().status, 'stopped');
});
