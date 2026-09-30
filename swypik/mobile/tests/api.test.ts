import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { httpsMedia, parseFeed, parseProducts, resolveApiOrigin, readApi } from '../src/lib/api.ts';
test('public API origin is configurable and rejects paths, credentials and unsafe schemes', () => {
  assert.equal(resolveApiOrigin(), 'https://swypik.com');
  assert.equal(resolveApiOrigin('https://staging.example.test/'), 'https://staging.example.test');
  for (const value of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/api', 'https://example.test?x=1', 'https://example.test#x', ' https://example.test', 'https://example.test\\evil', 'https://localhost', 'https://*.example.test']) assert.throws(() => resolveApiOrigin(value));
});
test('public transport omits cookies and cache and rejects redirects', async () => {
  const original = globalThis.fetch;
  let options: RequestInit | undefined;
  globalThis.fetch = async (_url, init) => {
    options = init;
    const response = new Response('{}', { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  };
  try {
    await assert.rejects(readApi('/api/explore/feed?limit=12', new AbortController().signal));
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.cache, 'no-store');
  } finally { globalThis.fetch = original; }
});
test('rejects unsafe media schemes and embedded credentials', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://example.com/a', 'https://user:pass@example.com/a']) assert.equal(httpsMedia(url), null);
  assert.equal(httpsMedia('/media/a.mp4'), 'https://swypik.com/media/a.mp4');
});
test('recognizes real empty feed but rejects an invalid contract', () => {
  assert.deepEqual(parseFeed({ items: [] }), []);
  assert.throws(() => parseFeed({ videos: [] }));
  assert.deepEqual(parseFeed({items:[{kind:'video',video:{id:'a',url:'file:///secret'}}]}), []);
});
test('uses safe fallback and skips nonvideo feed cards', () => {
  assert.deepEqual(parseFeed({items:[{kind:'card'}, {kind:'video',video:{id:'a',hlsUrl:'http://bad.test/a',url:'https://cdn.swypik.com/a.mp4',creator:{username:'creator'}}}]}), [{id:'a',url:'https://cdn.swypik.com/a.mp4',description:'',creator:'creator'}]);
});
test('does not convert invalid price into a free product', () => {
  const data = parseProducts({currency:'RON',products:[{id:'a',title:'A',price:'10'}, {id:'b',title:'B',price:-1}, {id:'c',title:'C',price:12.5,thumbnail:'javascript:alert(1)'}]});
  assert.deepEqual(data, {currency:'RON',products:[{id:'c',title:'C',price:12.5,image:null}]});
});
