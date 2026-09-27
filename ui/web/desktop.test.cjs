const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function desktop(fetch) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { value: '', textContent: '', style: {}, src: '',
        classList: { add: v => classes.add(v), remove: v => classes.delete(v),
          contains: v => classes.has(v), toggle: v => classes.has(v) ? classes.delete(v) : classes.add(v) },
        addEventListener() {} });
    }
    return elements.get(id);
  }
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById: element },
    URL, encodeURIComponent, fetch, navigator: {}, window: { open() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'desktop.js'), 'utf8'), context);
  return { context, element };
}

test('failed command keeps input and reports failure', async () => {
  const { context, element } = desktop(async () => ({ ok: false, status: 500 }));
  element('omnibar-input').value = 'run go version';
  await vm.runInContext('handleOmnibarSubmit()', context);
  assert.equal(element('omnibar-input').value, 'run go version');
  assert.match(element('omnibar-feedback').textContent, /Could not execute/);
});

test('network errors never claim execution succeeded', async () => {
  const { context, element } = desktop(async () => { throw new Error('offline'); });
  element('omnibar-input').value = 'hello';
  await vm.runInContext('handleOmnibarSubmit()', context);
  assert.match(element('omnibar-feedback').textContent, /offline/);
  assert.equal(element('omnibar-input').value, 'hello');
});

test('navigation restores a hidden browser and keeps query parameters', () => {
  const { context, element } = desktop();
  element('browser-window').classList.add('hidden');
  element('browser-window').style.opacity = '0';
  vm.runInContext("navigateToUrl('https://example.com/path?q=test#part')", context);
  assert.equal(element('browser-window').classList.contains('hidden'), false);
  assert.equal(element('browser-window').style.opacity, '1');
  assert.equal(element('browser-url-input').value, 'https://example.com/path?q=test#part');
  assert.match(element('browser-iframe').src, /^\/api\/proxy\?url=/);
});

test('clipboard failure is reported', async () => {
  const { context, element } = desktop();
  await vm.runInContext('shareCurrent()', context);
  assert.match(element('omnibar-feedback').textContent, /Could not copy/);
});
