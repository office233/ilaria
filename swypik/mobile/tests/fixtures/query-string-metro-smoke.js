// Bundle this fixture with Expo's Android/iOS Metro configuration, then run it
// with Node or the standalone Hermes runtime. It checks the ESM/CommonJS boundary.
const queryString = require('query-string');
const { getStateFromPath } = require('expo-router/build/react-navigation/core/getStateFromPath');

function equal(actual, expected) {
  if (actual !== expected) {
    throw new Error('Query decoder interoperability regression');
  }
}

const parsed = queryString.parse('space=a+b&plus=a%2Bb&unicode=%F0%9F%98%80&broken=%C3%41');
equal(parsed.space, 'a b');
equal(parsed.plus, 'a+b');
equal(parsed.unicode, '😀');
equal(parsed.broken, '%C3A');
equal(queryString.parse('q=%FE%FF').q, '\uFFFD\uFFFD');
equal(queryString.parse('q=%2525').q, '%25');

const payload = '%80'.repeat(20000);
equal(queryString.parse('q=' + payload).q, payload);
const state = getStateFromPath('/shop?q=a%2Bb&broken=' + payload, { screens: { Shop: 'shop' } });
equal(state.routes[0].name, 'Shop');
equal(state.routes[0].params.q, 'a+b');
equal(state.routes[0].params.broken, payload);
globalThis.__SWYPIK_QUERY_INTEROP_SMOKE_PASSED__ = true;
if (typeof globalThis.print === 'function') {
  globalThis.print('Swypik query-string Metro/Hermes interoperability PASS');
} else {
  console.log('Swypik query-string Metro/Hermes interoperability PASS');
}
