import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthController, type AuthApi } from '../src/lib/auth-core.ts';
import { IlariaClient, type IlariaState } from '../src/lib/ilaria-api.ts';

async function auth() {
  const api: AuthApi = { inferenceOrigin: 'https://auth.example.test',
    async login() { return { token: 'a'.repeat(64), expiresAt: '2030-01-01T00:00:00Z' }; },
    async profile() { return { userId: 'fixture-user', role: 'shopper', email: null, displayName: null }; },
    async refresh() { throw new Error('unused'); }, async revoke() {} };
  const controller = new AuthController(api, { async read() { return null; }, async write() {} }, true);
  await controller.signIn('fixture@example.test', 'synthetic-password');
  return controller;
}
function control(task: string, status = 'stopped') {
  return { protocol_version: 1, task_id: task, expert_id: 'GatewayControl', expert_version: 'gateway-v1',
    hypothesis: '', claims: [], evidence_refs: [], contradictions: [], uncertainty_ppm: 1000000, confidence_ppm: 0,
    next_expert_suggestions: [], verification_requirements: [], proposed_swyp_plan: '', latent_summary: '',
    compute_cost: 0, runtime_metrics: { execution_status: status, training: 'unavailable', energy_joules: 'unmeasured' } };
}
function inference(task: string) {
  const hash = 'a'.repeat(64);
  return { protocol_version: 1, task_id: task, expert_id: 'IMC', expert_version: 'imc-v1:' + hash,
    hypothesis: 'fixture answer', claims: [], evidence_refs: ['model:sha256:' + hash], contradictions: [],
    uncertainty_ppm: 0, confidence_ppm: 1000000, next_expert_suggestions: [], verification_requirements: [],
    proposed_swyp_plan: '', latent_summary: '', compute_cost: 1,
    runtime_metrics: { execution_status: 'succeeded', training: 'unavailable', canary: 'false',
      model_hash: hash, tokenizer_hash: hash, config_hash: hash, canonical_source_hash: hash,
      forward_passes: '1', output_tokens: '1' } };
}
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
