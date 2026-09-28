import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthController, AuthError, createAuthApi, parseProfile, parseSession, resolveAuthConfig,
  type AuthApi, type SessionRecord, type SessionStorage } from '../src/lib/auth-core.ts';

const TOKEN = 'a'.repeat(64);
const NEXT = 'b'.repeat(64);
const session: SessionRecord = { token: TOKEN, expiresAt: '2030-01-01T00:00:00.000Z' };
const successor: SessionRecord = { token: NEXT, expiresAt: '2030-02-01T00:00:00.000Z' };
const profile = { userId: 'fixture-user', role: 'shopper' as const, email: 'fixture@example.test', displayName: 'Cont de test' };
const config = resolveAuthConfig('1', 'https://auth.example.test', 'android');

function memory(initial: string | null = null) {
  const store = { value: initial, reads: 0, writes: 0, failRead: false as boolean, failWrite: false as boolean,
    async read() { this.reads++; if (this.failRead) throw new Error('storage'); return this.value; },
    async write(value: string | null) { this.writes++; if (this.failWrite) throw new Error('storage'); this.value = value; },
  } satisfies SessionStorage & { value: string | null; reads: number; writes: number; failRead: boolean; failWrite: boolean };
  return store;
}
function api(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    async login() { return session; }, async profile() { return profile; },
    async refresh() { return successor; }, async revoke() {}, ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const body = (record = session) => ({ success: true, access_token: record.token, expires_at: record.expiresAt });
const jsonFetch = (value: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(value), { status });

// Only synthetic fixtures and injected transports are used. No live authentication or database calls.
test('native authentication requires an explicit enabled flag and origin', () => {
  assert.equal(resolveAuthConfig(undefined, 'https://auth.example.test', 'ios').enabled, false);
  assert.equal(resolveAuthConfig('1', undefined, 'ios').enabled, false);
  assert.equal(resolveAuthConfig('true', 'https://auth.example.test', 'ios').enabled, false);
  assert.deepEqual(config, { enabled: true, origin: 'https://auth.example.test' });
});
test('web authentication remains disabled even with an enabled flag', () => {
  assert.equal(resolveAuthConfig('1', 'https://auth.example.test', 'web').enabled, false);
});
for (const origin of ['http://auth.example.test', 'https://name:pass@auth.example.test', 'https://auth.example.test/api',
  'https://auth.example.test?x=1', 'https://auth.example.test#x', 'https://*.example.test',
  ' https://auth.example.test', 'https://auth.example.test\\evil', 'https://auth.example.test?', 'https://localhost']) {
  test(`reject unsafe origin ${origin}`, () => { assert.equal(resolveAuthConfig('1', origin, 'android').enabled, false); });
}
test('session validation accepts the documented contract only', () => {
  assert.deepEqual(parseSession(session), session);
  assert.throws(() => parseSession({ ...session, token: 'not-a-token' }), AuthError);
  assert.throws(() => parseSession({ ...session, expiresAt: 'next week' }), AuthError);
  assert.throws(() => parseSession({ ...session, expiresAt: '2020-01-01T00:00:00Z' }), /expired/);
  assert.throws(() => parseSession(null), AuthError);
});
test('profile identity comes from a valid server response', () => {
  assert.deepEqual(parseProfile({ ok: true, user: profile }), profile);
  assert.throws(() => parseProfile({ ok: false, user: profile }), AuthError);
  assert.throws(() => parseProfile({ ok: true, user: { ...profile, role: 'owner' } }), AuthError);
  assert.throws(() => parseProfile({ ok: true, user: { ...profile, userId: '' } }), AuthError);
});
test('transport uses fixed HTTPS URLs, no cookies, no cache, and rejects redirects', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(String(url).endsWith('/me') ? { ok: true, user: profile } : body()));
  };
  const client = createAuthApi(config, fetcher);
  await client.login('  FIXTURE@example.test ', 'synthetic-password');
  await client.profile(TOKEN);
  assert.equal(calls[0].url, 'https://auth.example.test/api/auth/token');
  assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { email: 'fixture@example.test', password: 'synthetic-password' });
  assert.equal(calls[1].url, 'https://auth.example.test/api/auth/me');
  for (const call of calls) {
    assert.equal(call.options?.credentials, 'omit');
    assert.equal(call.options?.redirect, 'error');
    assert.equal(call.options?.cache, 'no-store');
  }
  assert.equal(new Headers(calls[0].options?.headers).get('Authorization'), null);
  assert.equal(new Headers(calls[1].options?.headers).get('Authorization'), `Bearer ${TOKEN}`);
});
test('disabled transport never sends a request', async () => {
  let count = 0;
  const client = createAuthApi({ enabled: false, reason: 'test' }, async () => { count++; return new Response(); });
  await assert.rejects(client.login('fixture@example.test', 'synthetic-password'), /disabled/);
  assert.equal(count, 0);
});
test('invalid credentials format is rejected before the network', async () => {
  let count = 0;
  const client = createAuthApi(config, async () => { count++; return new Response(); });
  await assert.rejects(client.login('bad-address', 'short'), /invalid_input/);
  await assert.rejects(client.profile('bad-token'), /invalid_token/);
  assert.equal(count, 0);
});
for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate_limited'], [503, 'server']] as const) {
  test(`transport maps HTTP ${status} without exposing server content`, async () => {
    await assert.rejects(createAuthApi(config, jsonFetch({ detail: 'private server text' }, status)).profile(TOKEN), new RegExp(code));
  });
}
test('transport rejects a malformed successful response', async () => {
  await assert.rejects(createAuthApi(config, jsonFetch({ success: true, access_token: 'bad' })).login('fixture@example.test', 'synthetic-password'), /invalid_response/);
});
test('transport timeout aborts and does not retry', async () => {
  let count = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    count++;
    return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  };
  await assert.rejects(createAuthApi(config, fetcher, 5).profile(TOKEN), /timeout/);
  assert.equal(count, 1);
});
test('login persists only token and expiry after the server validates the profile', async () => {
  const store = memory();
  const controller = new AuthController(api(), store, true);
  await controller.signIn('fixture@example.test', 'synthetic-password');
  assert.deepEqual(controller.getState(), { status: 'authenticated', user: profile });
  assert.deepEqual(JSON.parse(store.value!), session);
  assert.equal(store.value!.includes('synthetic-password'), false);
  assert.equal(store.value!.includes('shopper'), false);
});
test('restore validates the profile and ignores any locally stored role', async () => {
  const store = memory(JSON.stringify({ ...session, role: 'admin' }));
  const controller = new AuthController(api(), store, true);
  await controller.restore();
  assert.equal(controller.getState().user?.role, 'shopper');
});
test('restore with a revoked token clears storage and authenticated identity', async () => {
  const store = memory(JSON.stringify(session));
  const controller = new AuthController(api({ async profile() { throw new AuthError('unauthorized'); } }), store, true);
  await controller.restore();
  assert.equal(store.value, null);
  assert.equal(controller.getState().user, null);
});
test('offline restore keeps the token but hides the unvalidated profile', async () => {
  const store = memory(JSON.stringify(session));
  const controller = new AuthController(api({ async profile() { throw new AuthError('network'); } }), store, true);
  await controller.restore();
  assert.equal(controller.getState().status, 'offline');
  assert.equal(controller.getState().user, null);
  assert.notEqual(store.value, null);
});
test('expired and corrupt stored sessions never reach the API', async () => {
  for (const stored of ['not-json', JSON.stringify({ ...session, expiresAt: '2020-01-01T00:00:00Z' })]) {
    let count = 0;
    const store = memory(stored);
    const controller = new AuthController(api({ async profile() { count++; return profile; } }), store, true);
    await controller.restore();
    assert.equal(count, 0);
    assert.equal(store.value, null);
    assert.equal(controller.getState().user, null);
  }
});
test('concurrent refresh is single-flight and saves the successor once', async () => {
  const pending = deferred<SessionRecord>();
  let count = 0;
  const store = memory();
  const controller = new AuthController(api({ async refresh() { count++; return pending.promise; } }), store, true);
  await controller.signIn('fixture@example.test', 'synthetic-password');
  const first = controller.refresh();
  assert.equal(controller.refresh(), first);
  pending.resolve(successor);
  await first;
  assert.equal(count, 1);
  assert.deepEqual(JSON.parse(store.value!), successor);
});
test('logout during login cannot restore a late session', async () => {
  const pending = deferred<SessionRecord>();
  const revoked: string[] = [];
  const store = memory();
  const controller = new AuthController(api({ async login() { return pending.promise; }, async revoke(token) { revoked.push(token); } }), store, true);
  const login = controller.signIn('fixture@example.test', 'synthetic-password');
  await controller.signOut();
  pending.resolve(session);
  await login;
  assert.equal(controller.getState().status, 'signed-out');
  assert.equal(store.value, null);
  assert.deepEqual(revoked, [TOKEN]);
});
test('logout during refresh revokes the late successor and remains signed out', async () => {
  const pending = deferred<SessionRecord>();
  const revoked: string[] = [];
  const store = memory();
  const controller = new AuthController(api({ async refresh() { return pending.promise; }, async revoke(token) { revoked.push(token); } }), store, true);
  await controller.signIn('fixture@example.test', 'synthetic-password');
  const refresh = controller.refresh();
  await controller.signOut();
  pending.resolve(successor);
  await refresh;
  assert.equal(controller.getState().status, 'signed-out');
  assert.equal(store.value, null);
  assert.deepEqual(revoked, [TOKEN, NEXT]);
});
test('failed remote revoke still clears local storage and reports uncertainty', async () => {
  const store = memory();
  const controller = new AuthController(api({ async revoke() { throw new AuthError('network'); } }), store, true);
  await controller.signIn('fixture@example.test', 'synthetic-password');
  await controller.signOut();
  assert.equal(store.value, null);
  assert.equal(controller.getState().status, 'signed-out');
  assert.match(controller.getState().message!, /nu a putut fi confirmată/);
});
test('storage write failures never produce an authenticated session', async () => {
  const revoked: string[] = [];
  const store = memory(); store.failWrite = true;
  const controller = new AuthController(api({ async revoke(token) { revoked.push(token); } }), store, true);
  await controller.signIn('fixture@example.test', 'synthetic-password');
  assert.equal(controller.getState().status, 'error');
  assert.equal(controller.getState().user, null);
  assert.equal(store.value, null);
  assert.deepEqual(revoked, [TOKEN]);
});
test('storage read failures are surfaced without creating an identity', async () => {
  const store = memory(); store.failRead = true;
  const controller = new AuthController(api(), store, true);
  await controller.restore();
  assert.equal(controller.getState().status, 'error');
  assert.equal(controller.getState().user, null);
});
test('logout reports secure-storage deletion failure truthfully', async () => {
  const store = memory();
  const controller = new AuthController(api(), store, true);
  await controller.signIn('fixture@example.test', 'synthetic-password');
  store.failWrite = true;
  await controller.signOut();
  assert.equal(controller.getState().status, 'error');
  assert.match(controller.getState().message!, /ștergerea/);
});
test('ambiguous refresh failure clears local session and is not retried', async () => {
  let count = 0;
  const store = memory();
  const controller = new AuthController(api({ async refresh() { count++; throw new AuthError('network'); } }), store, true);
  await controller.signIn('fixture@example.test', 'synthetic-password');
  await controller.refresh();
  assert.equal(store.value, null);
  assert.equal(controller.getState().status, 'error');
  assert.equal(count, 1);
});
test('refresh cannot switch the authenticated user', async () => {
  const store = memory();
  const controller = new AuthController(api({ async profile(token) { return token === NEXT ? { ...profile, userId: 'other-user' } : profile; } }), store, true);
  await controller.signIn('fixture@example.test', 'synthetic-password');
  await controller.refresh();
  assert.equal(controller.getState().status, 'error');
  assert.equal(controller.getState().user, null);
  assert.equal(store.value, null);
});
test('disabled controller never reads storage or calls the API', async () => {
  let count = 0;
  const store = memory();
  const controller = new AuthController(api({ async login() { count++; return session; } }), store, false);
  await controller.restore(); await controller.signIn('fixture@example.test', 'synthetic-password');
  await controller.refresh(); await controller.signOut();
  assert.equal(count, 0); assert.equal(store.reads, 0); assert.equal(store.writes, 0);
  assert.equal(controller.getState().status, 'signed-out');
});
