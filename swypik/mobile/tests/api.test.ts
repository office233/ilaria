import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { httpsMedia, parseFeed, parseProducts } from '../src/lib/api.ts';
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
