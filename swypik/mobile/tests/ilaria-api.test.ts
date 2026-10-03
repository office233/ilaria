import assert from 'node:assert/strict';

test('request identities reject trailing control characters without normalization', () => {
  assert.throws(() => makeRequest('public fixture', 'fixture-user\n'));
});
test('wrong MIME and lossy native body are refused', async () => {
  await assert.rejects(readBounded(new Response('{}', { headers: { 'Content-Type': 'application/jsonx' } }), new AbortController().signal));
});
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strictJSON, utf8Bytes, makeRequest, decodeResponse, readBounded, REQUEST_FIELDS, RESPONSE_FIELDS, WireError } from '../src/lib/ilaria-wire.ts';
import { inferenceResponse, controlResponse } from './fixtures/ilaria.ts';

test('projection matches canonical Myriad manifest, never a parallel DTO', () => {
  const path = process.env.NEXUS_MYRIAD_MANIFEST ?? resolve(import.meta.dirname, '..', '..', '..', 'ilaria', 'specs', 'myriad.manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const [name, actual] of [['CorticalRequest', REQUEST_FIELDS], ['CorticalResponse', RESPONSE_FIELDS]] as const) {
    const record = manifest.declarations.find((d: { name: string }) => d.name === name);
    const expected = Object.fromEntries(record.fields.map((f: { name: string; type: string }) => [f.name, f.type]));
    assert.deepEqual(actual, expected);
  }
});
for (const raw of ['{"x":1,"x":2}', '{"x":1e0}', '{"x":1.0}', '{"x":9007199254740992}', '{"x":NaN}', '{"x":"\\ud800"}',
  '{"x":"\\udc00"}', '{}{}', '{"x":null,}', '['.repeat(18) + '0' + ']'.repeat(18), ' '.repeat(65537)]) {
  test('strict JSON refusal ' + raw.slice(0, 35), () => assert.throws(() => strictJSON(raw)));
}
test('valid Unicode is lossless and byte limits are encoded bytes', () => {
  assert.equal(utf8Bytes('ă🚀'), 6);
  assert.equal((strictJSON('{"value":"\\ud83d\\ude80"}') as { value: string }).value, '🚀');
  assert.throws(() => makeRequest('🚀'.repeat(1025), 'fixture-user'));
});
test('request is inference-only, private, with no training/tools/global context', () => {
  const value = makeRequest('public fixture question', 'fixture-user', 1000, 2000);
  assert.equal(value.deadline_unix_ms, 2000);
  assert.deepEqual(value.constraints, ['no_training', 'no_tools']);
  assert.equal(value.requested_role, 'inference');
  assert.equal(value.privacy_class, 'LOCAL_PRIVATE');
  assert.deepEqual(value.tool_observations, []);
});
test('decoder refuses unsafe/mismatched model replies', () => {
  assert.throws(() => decodeResponse('{}', 'test.1'));
});
test('capture rejects oversized declared or streamed responses', async () => {
  await assert.rejects(readBounded(new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' } }), new AbortController().signal));
  await assert.rejects(readBounded(new Response('x'.repeat(65537), { headers: { 'Content-Type': 'application/json' } }), new AbortController().signal));
});
test('aborted slow body does not leave caller waiting', async () => {
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } });
  const work = readBounded(response, controller.signal);
  controller.abort();
  await assert.rejects(work);
});

test('valid inference and terminal controls use the exact correlated response shape', () => {
  const response = inferenceResponse('test.1');
  assert.deepEqual(JSON.parse(JSON.stringify(decodeResponse(JSON.stringify(response), 'test.1'))), response);
  for (const status of ['stopped', 'succeeded', 'failed']) {
    assert.equal(decodeResponse(JSON.stringify(controlResponse('test.1', status)), 'test.1', true).runtime_metrics.execution_status, status);
  }
});
for (const mutation of ['task', 'plan', 'training', 'hash', 'extra', 'cost'] as const) {
  test('reject correlated-looking but invalid inference evidence: ' + mutation, () => {
    const response = inferenceResponse('test.1');
    if (mutation === 'task') response.task_id = 'wrong-task';
    if (mutation === 'plan') response.proposed_swyp_plan = 'unapproved effect';
    if (mutation === 'training') response.runtime_metrics.training = 'active';
    if (mutation === 'hash') delete response.runtime_metrics.model_hash;
    if (mutation === 'cost') response.compute_cost = 2;
    const wire = mutation === 'extra' ? { ...response, authority: 'not-a-capability' } : response;
    assert.throws(() => decodeResponse(JSON.stringify(wire), 'test.1'), WireError);
  });
}
test('declared body length must match actual UTF-8 bytes on streaming and native buffered transports', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(readBounded(new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '3' } }), signal), WireError);
  const buffered = new Response('ă', { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } });
  Object.defineProperty(buffered, 'body', { value: null });
  await assert.rejects(readBounded(buffered, signal), WireError);
});
