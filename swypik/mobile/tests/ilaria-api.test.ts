import assert from 'node:assert/strict';

test('request identities reject trailing control characters without normalization', () => {
  assert.throws(() => makeRequest('public fixture', 'fixture-user\n'));
});
test('wrong MIME and lossy native body are refused', async () => {
  await assert.rejects(readBounded(new Response('{}', { headers: { 'Content-Type': 'application/jsonx' } }), new AbortController().signal));
});
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { strictJSON, utf8Bytes, makeRequest, decodeResponse, readBounded, REQUEST_FIELDS, RESPONSE_FIELDS } from '../src/lib/ilaria-wire.ts';

test('projection matches supplied canonical Myriad manifest, never a parallel DTO', { skip: !process.env.NEXUS_MYRIAD_MANIFEST }, () => {
  const manifest = JSON.parse(readFileSync(process.env.NEXUS_MYRIAD_MANIFEST!, 'utf8'));
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
