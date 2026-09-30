import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const queryString = require('query-string');
const decoder = require('decode-uri-component').default;
const { getStateFromPath } = require('expo-router/build/react-navigation/core/getStateFromPath');

test('unsupported Node versions fail installation with a clear runtime requirement', () => {
  const result = spawnSync(process.execPath, ['-e', `
    Object.defineProperty(process.versions, 'node', { value: '18.20.8' });
    require('./scripts/apply-query-string-interop.cjs');
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires Node\.js >=24\.3\.0; use Node\.js 24 LTS/);
});

test('CommonJS query-string loads the fixed synchronous ESM decoder', () => {
  assert.equal(typeof decoder, 'function');
  for (const key of ['parse', 'stringify', 'parseUrl', 'stringifyUrl', 'pick', 'exclude']) {
    assert.equal(typeof queryString[key], 'function');
  }
  assert.equal(queryString.parse('search=crem%C4%83').search, 'cremă');
});

test('URI parsing preserves spaces, literal plus, Unicode and reserved characters', () => {
  assert.deepEqual({ ...queryString.parse('space=a+b&plus=a%2Bb&unicode=%F0%9F%98%80&reserved=%2F%3F%23') }, {
    space: 'a b', plus: 'a+b', unicode: '😀', reserved: '/?#',
  });
  assert.equal(decoder('a+b'), 'a+b');
  assert.equal(queryString.parse('q=%2525').q, '%25');
});

test('malformed UTF-8 keeps valid bytes and the decoder replacement behavior', () => {
  const cases = [
    ['%st%C3%A5le%', '%ståle%'],
    ['%C3%A5%80%C3%A5', 'å%80å'],
    ['%FE%FF', '\uFFFD\uFFFD'],
    ['%C2', '\uFFFD'],
    ['%F0%9F%41', '%F0%9FA'],
    ['%ED%A0%80', '%ED%A0%80'],
    ['%84%D7%25%88%90', '%84%D7%%88%90'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(queryString.parse(`q=${input}`).q, expected);
  }
});

test('repeated values, nulls, empty values and disabled decoding retain query-string 7 semantics', () => {
  assert.deepEqual({ ...queryString.parse('q=1&q=2&flag&empty=') }, {
    q: ['1', '2'], flag: null, empty: '',
  });
  assert.deepEqual({ ...queryString.parse('q=a+b%20c', { decode: false }) }, { q: 'a+b%20c' });
  assert.deepEqual({ ...queryString.parse('q[]=a%2Bb&q[]=c+d', { arrayFormat: 'bracket' }) }, {
    q: ['a+b', 'c d'],
  });
});

test('URL query and fragment round-trip through the original public API', () => {
  const result = queryString.parseUrl('https://example.test/shop?q=a%2Bb#ofert%C4%83', { parseFragmentIdentifier: true });
  assert.equal(result.url, 'https://example.test/shop');
  assert.equal(result.query.q, 'a+b');
  assert.equal(result.fragmentIdentifier, 'ofertă');
  const url = queryString.stringifyUrl(result);
  const reparsed = queryString.parseUrl(url, { parseFragmentIdentifier: true });
  assert.deepEqual(reparsed, result);
});

test('query keys retain a null prototype and do not pollute Object.prototype', () => {
  const parsed = queryString.parse('__proto__=value&constructor=x&prototype=y');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(parsed.__proto__, 'value');
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'value'), false);
});

test('Expo Router consumes encoded and malformed deep-link query values', () => {
  const state = getStateFromPath('/shop?q=a%2Bb&unicode=%F0%9F%98%80&broken=%C3%41', {
    screens: { Shop: 'shop' },
  });
  assert.equal(state.routes[0].name, 'Shop');
  assert.deepEqual({ ...state.routes[0].params }, { q: 'a+b', unicode: '😀', broken: '%C3A' });
});

test('malformed percent runs cannot hang query parsing or Expo deep-link parsing', () => {
  // Run in a child so a regression in synchronous decoding is killed by timeout.
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const query = require('query-string');
    const { getStateFromPath } = require('expo-router/build/react-navigation/core/getStateFromPath');
    const payload = '%80'.repeat(20000);
    assert.equal(query.parse('q=' + payload).q, payload);
    const state = getStateFromPath('/shop?q=' + payload, { screens: { Shop: 'shop' } });
    assert.equal(state.routes[0].params.q, payload);
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
});
