import assert from 'node:assert/strict';
import test from 'node:test';
import { IlariaClient, type IlariaState } from '../src/lib/ilaria-api.ts';
import { fixtureAuth as auth, controlResponse as control, inferenceResponse as inference } from './fixtures/ilaria.ts';

for (const event of ['background', 'logout', 'consent', 'unmount'] as const) {
  test('foreground client cancels and discards late inference after ' + event, async () => {
    const controller = await auth();
    const states: IlariaState[] = [];
    let resolve!: (value: Response) => void;
    let cancelled = 0;
    const transport: typeof fetch = async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (String(url).endsWith('/cancel')) {
        cancelled++;
        return new Response(JSON.stringify(control(request.task_id)), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Promise<Response>(yes => { resolve = yes; });
    };
    const client = new IlariaClient(controller, value => states.push(value), transport);
    client.setForeground(true); client.setRemoteConsent(true);
    const running = client.start('public fixture');
    if (event === 'background') client.setForeground(false);
    if (event === 'logout') await controller.signOut();
    if (event === 'consent') client.setRemoteConsent(false);
    if (event === 'unmount') client.close();
    await client.cancel();
    resolve(new Response('invalid late reply'));
    await running;
    assert.equal(cancelled, 1);
    assert.equal(states.some(value => value.status === 'succeeded'), false);
    assert.equal(client.getState().response, null);
    client.close();
  });
}
test('no consent or no foreground never sends inference', async () => {
  let calls = 0; const controller = await auth();
  const client = new IlariaClient(controller, () => {}, async () => { calls++; return new Response(); });
  await client.start('public fixture'); client.setRemoteConsent(true); await client.start('public fixture');
  assert.equal(calls, 0); client.close();
});
test('uncertain server cancellation is never reported as verified stopped', async () => {
  const controller = await auth();
  let resolve!: (response: Response) => void;
  const client = new IlariaClient(controller, () => {}, async (url, init) => {
    if (String(url).endsWith('/cancel')) {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(control(request.task_id, 'uncertain')), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Promise<Response>(yes => { resolve = yes; });
  });
  client.setForeground(true); client.setRemoteConsent(true);
  const running = client.start('public fixture'); await client.cancel();
  assert.equal(client.getState().status, 'uncertain');
  resolve(new Response('late')); await running; client.close();
});

test('expired response continuation is cancelled even before the timeout callback runs', async () => {
  const controller = await auth();
  let resolve!: (response: Response) => void;
  let cancelled = 0;
  let taskId = '';
  const client = new IlariaClient(controller, () => {}, async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(url).endsWith('/cancel')) {
      cancelled++;
      return new Response(JSON.stringify(control(request.task_id)), { headers: { 'Content-Type': 'application/json' } });
    }
    taskId = request.task_id;
    return new Promise<Response>(yes => { resolve = yes; });
  });
  client.setForeground(true); client.setRemoteConsent(true);
  const running = client.start('public fixture');
  const originalNow = Date.now;
  try {
    const beforeDeadline = originalNow();
    Date.now = () => beforeDeadline + 25_001;
    resolve(new Response(JSON.stringify(inference(taskId)),
      { headers: { 'Content-Type': 'application/json' } }));
    await running;
    await client.cancel();
  } finally {
    Date.now = originalNow;
  }
  assert.equal(cancelled, 1);
  assert.notEqual(client.getState().status, 'succeeded');
  assert.equal(client.getState().response, null);
  client.close();
});

for (const failure of ['network', 'http', 'malformed', 'budget'] as const) {
  test('failed inference reconciles remote execution before releasing its lease: ' + failure, async () => {
    const controller = await auth();
    let cancelled = 0;
    const client = new IlariaClient(controller, () => {}, async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (String(url).endsWith('/cancel')) {
        cancelled++;
        return new Response(JSON.stringify(control(request.task_id)), { headers: { 'Content-Type': 'application/json' } });
      }
      if (failure === 'network') throw new TypeError('synthetic offline transport');
      if (failure === 'http') return new Response('', { status: 503 });
      if (failure === 'malformed') return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      const answer = inference(request.task_id);
      answer.compute_cost = 5;
      answer.runtime_metrics.forward_passes = answer.runtime_metrics.output_tokens = '5';
      return new Response(JSON.stringify(answer), { headers: { 'Content-Type': 'application/json' } });
    });
    try {
      client.setForeground(true); client.setRemoteConsent(true);
      await client.start('public fixture');
      assert.equal(cancelled, 1, 'a failed response is not evidence that the executor stopped');
      assert.ok(['error', 'offline'].includes(client.getState().status));
      assert.equal(client.getState().response, null);
    } finally { client.close(); }
  });
}

test('unconfirmed execution survives preference changes and blocks retry until correlated reconciliation', async () => {
  const controller = await auth();
  let resolve!: (response: Response) => void;
  let inferred = 0;
  let confirmed = false;
  const client = new IlariaClient(controller, () => {}, async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(url).endsWith('/cancel')) {
      return new Response(JSON.stringify(control(request.task_id, confirmed ? 'stopped' : 'uncertain')),
        { headers: { 'Content-Type': 'application/json' } });
    }
    inferred++;
    return new Promise<Response>(yes => { resolve = yes; });
  });
  client.setForeground(true); client.setRemoteConsent(true);
  const running = client.start('public fixture');
  try {
    await client.cancel();
    client.setForeground(false); client.setRemoteConsent(false);
    assert.equal(client.getState().status, 'uncertain');
    client.setForeground(true); client.setRemoteConsent(true);
    await client.start('must not be sent');
    assert.equal(inferred, 1);
    assert.equal(client.getState().status, 'uncertain');
    confirmed = true;
    await client.cancel();
    assert.equal(client.getState().status, 'stopped');
  } finally {
    resolve(new Response('late reply')); await running; client.close();
  }
});

test('abort-ignoring inference and cancellation transports still settle within the control deadline', async t => {
  const controller = await auth();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = 0;
  const client = new IlariaClient(controller, () => {}, async url => {
    if (String(url).endsWith('/cancel')) cancelled++;
    return new Promise<Response>(() => {});
  });
  try {
    client.setForeground(true); client.setRemoteConsent(true);
    const running = client.start('public fixture');
    const cancellation = client.cancel();
    t.mock.timers.tick(2001);
    await cancellation; await running;
    assert.equal(cancelled, 1);
    assert.equal(client.getState().status, 'uncertain');
    await client.start('must not be sent');
    assert.equal(cancelled, 1);
  } finally {
    client.close();
    t.mock.timers.tick(2001);
    await client.cancel();
    t.mock.timers.reset();
  }
});

test('screen remount and reauthentication cannot replay an unconfirmed execution', async () => {
  const controller = await auth();
  let calls = 0;
  const transport: typeof fetch = async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(control(request.task_id, 'uncertain')),
      { headers: { 'Content-Type': 'application/json' } });
  };
  const first = new IlariaClient(controller, () => {}, transport);
  first.setForeground(true); first.setRemoteConsent(true);
  await first.start('public fixture');
  first.close();
  await first.cancel();
  await controller.signOut();
  await controller.signIn('fixture@example.test', 'synthetic-password');
  const before = calls;
  const second = new IlariaClient(controller, () => {}, transport);
  try {
    second.setForeground(true); second.setRemoteConsent(true);
    await second.start('must not be sent');
    assert.equal(calls, before);
    assert.equal(second.getState().status, 'uncertain');
    assert.equal(second.getState().response, null);
  } finally { second.close(); }
});

test('session replacement withdraws inference consent instead of reusing it for a new login', async () => {
  const controller = await auth();
  let calls = 0;
  const client = new IlariaClient(controller, () => {}, async () => { calls++; return new Response(); });
  try {
    client.setForeground(true); client.setRemoteConsent(true);
    await controller.signOut();
    await controller.signIn('fixture@example.test', 'synthetic-password');
    await client.start('must not be sent');
    assert.equal(calls, 0);
  } finally { client.close(); }
});
