const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8');
const url = 'https://arizonaoutdoorsclub.com/trip-signup/?event_id=6421';
function background() {
  let listener;
  let removed;
  const data = {};
  const localData = {};
  const tabs = [{ id: 7, url }];
  const reloads = [];
  const alerts = [];
  const chrome = {
    runtime: { id: 'test-extension', onMessage: { addListener(fn) { listener = fn; } } },
    storage: { session: {
      async get() { return structuredClone(data); },
      async set(value) { Object.assign(data, structuredClone(value)); }
    }, local: {
      async get() { return structuredClone(localData); },
      async set(value) { Object.assign(localData, structuredClone(value)); }
    } },
    action: { async setBadgeText() {} },
    notifications: { async create(id, options) { alerts.push(options.message); } },
    tabs: {
      async query() { return structuredClone(tabs); },
      async create(options) { const tab = { id: tabs.length + 7, url: options.url }; tabs.push(tab); return tab; },
      async update() {}, async sendMessage() {},
      async reload(id) { reloads.push(id); },
      onRemoved: { addListener(fn) { removed = fn; } }
    }
  };
  vm.runInNewContext(read('background.js'), { chrome, URL, console });
  const popup = { id: chrome.runtime.id };
  const owner = { id: chrome.runtime.id, tab: { id: 7 }, url };
  return { alerts, reloads, removed, owner, tabs, localData, data, send: (message, sender = popup) => new Promise(resolve => listener(message, sender, resolve)) };
}
test('reuses event tab; authorizes one claim and refuses subsequent reloads', async () => {
  const app = background();
  assert.equal((await app.send({ type: 'startAll' })).watches['6421'].tabId, 7);
  assert.equal(app.tabs.length, 1);
  await app.send({ type: 'checked' }, app.owner);
  assert.deepEqual(app.reloads, []);
  const results = await Promise.all([
    app.send({ type: 'claim' }, app.owner),
    app.send({ type: 'claim' }, app.owner)
  ]);
  assert.equal(results.filter(result => result.click).length, 1);
  await app.send({ type: 'checked' }, app.owner);
  assert.deepEqual(app.reloads, []);
  assert.equal((await app.send({ type: 'state' }, app.owner)).running, false);
});
test('other tabs cannot claim or reload, and Stop disables the owner', async () => {
  const app = background();
  await app.send({ type: 'start' });
  const other = { ...app.owner, tab: { id: 9 } };
  assert.ok((await app.send({ type: 'claim' }, other)).error);
  await app.send({ type: 'checked' }, other);
  assert.equal(app.reloads.length, 0);
  await app.send({ type: 'stopAll' });
  assert.equal((await app.send({ type: 'claim' }, app.owner)).click, false);
});
test('launcher restricted to signup pages and closed tabs stop watching', async () => {
  const app = background();
  const wrong = { ...app.owner, url: 'https://example.com/trip-signup/?event_id=6421' };
  assert.ok((await app.send({ type: 'start', launcher: true }, wrong)).error);
  assert.equal((await app.send({ type: 'start', launcher: true }, app.owner)).watches['6421'].running, true);
  app.removed(7);
  assert.equal((await app.send({ type: 'state' })).watches['6421'].running, false);
});
function element(text, overrides = {}) {
  return {
    textContent: text, innerText: text, disabled: false,
    getAttribute() { return null; }, matches() { return false; }, closest() { return null; },
    getClientRects() { return [{}]; }, ...overrides
  };
}
test('matcher ignores hidden/disabled/unrelated text and finds nested button labels', () => {
  const context = { getComputedStyle: item => item.style || { visibility: 'visible', display: 'block' } };
  vm.runInNewContext(read('matcher.js'), context);
  const valid = element('  CLAIM\n  PASSENGER   SPOT  ');
  const nodes = [
    element('Claim spot', { disabled: true }),
    element('CLAIM DRIVER SPOT'),
    element('CLAIM PASSENGER SPOT', { disabled: true }),
    element('CLAIM PASSENGER SPOT', { getClientRects: () => [] }),
    element('CLAIM PASSENGER SPOT', { style: { visibility: 'hidden' } }),
    element('Do not CLAIM PASSENGER SPOT'), valid
  ];
  assert.equal(context.AOCMatcher.findClaim({ querySelectorAll: () => nodes }), valid);
  assert.equal(context.AOCMatcher.findClaim({ querySelectorAll: () => [element('Do not Claim spot'), element('CLAIM DRIVER SPOT')] }), undefined);
  const screenshotLabel = element('CLAIM PASSENGER SPOT');
  assert.equal(context.AOCMatcher.findClaim({ querySelectorAll: () => [screenshotLabel] }), screenshotLabel);
});
test('both claim labels work in live and silent checks, including case and whitespace variations', () => {
  const context = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
  vm.runInNewContext(read('matcher.js'), context);
  for (const label of ['CLAIM SPOT', ' Claim\n spot ', 'CLAIM PASSENGER SPOT']) {
    const button = element(label);
    for (const options of [{}, { rendered: false }]) {
      assert.equal(context.AOCMatcher.findClaim({ querySelectorAll: () => [button] }, '6421', options), button);
      button.disabled = true;
      assert.equal(context.AOCMatcher.isEligible(button, '6421', options), false);
      button.disabled = false;
    }
  }
});
for (const fixtureEventId of ['6421', '6228']) test(`event ${fixtureEventId} content stops its timer and clicks only once when a button appears`, async () => {
  let mutation;
  let candidate;
  let clicks = 0;
  const timers = new Set();
  const messages = [];
  const box = { checked: false, click() { this.checked = true; order.push('box'); } };
  const proceed = { disabled: false, click() { order.push('proceed'); } };
  const order = [];
  const context = {
    location: { pathname: '/trip-signup/', href: url.replace('6421', fixtureEventId), hash: '' }, URL, console,
    chrome: { runtime: {
      onMessage: { addListener() {} },
      async sendMessage(message) {
        messages.push(message.type);
        if (message.type === 'state') return { running: true, intervalMs: 100, eventId: fixtureEventId };
        if (message.type === 'claim') return { click: true };
        return {};
      }
    } },
    AOCMatcher: {
      findClaim(root, eventId) { assert.equal(eventId, fixtureEventId); return candidate; },
      isEligible(button, eventId) { assert.equal(eventId, fixtureEventId); return button === candidate; },
      findAgreement() { return { known: true, boxes: [box], proceed }; }
    },
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} disconnect() {} },
    document: { readyState: 'complete', body: { innerText: 'Full' }, querySelector() {}, addEventListener() {} },
    window: { addEventListener() {} },
    setTimeout(fn, ms) { assert.equal(ms, 100); timers.add(fn); return fn; },
    clearTimeout(fn) { timers.delete(fn); }
  };
  vm.runInNewContext(read('content.js'), context);
  await new Promise(setImmediate);
  assert.equal(timers.size, 1);
  candidate = { isConnected: true, disabled: false, click() { clicks++; } };
  mutation(); mutation();
  await new Promise(setImmediate);
  assert.equal(clicks, 1);
  assert.equal(timers.size, 0);
  assert.equal(messages.filter(type => type === 'claim').length, 1);
  assert.ok(messages.includes('clicked'));
  assert.deepEqual(order, ['box', 'proceed']);
  assert.equal(messages.filter(type => type === 'agreement').length, 1);
});
function agreementRun(findAgreement) {
  let mutation;
  let scheduled;
  const messages = [];
  const candidate = { isConnected: true, click() {} };
  let observers = 0;
  const context = {
    location: { pathname: '/trip-signup/', href: url, hash: '' }, URL, console,
    chrome: { runtime: {
      onMessage: { addListener() {} },
      async sendMessage(message) {
        messages.push(message);
        if (message.type === 'state') return { running: true, intervalMs: 100, eventId: '6421' };
        if (message.type === 'claim') return { click: true };
        return {};
      }
    } },
    AOCMatcher: { findClaim: () => candidate, isEligible: () => true, findAgreement },
    MutationObserver: class { constructor(fn) { if (observers++) mutation = fn; } observe() {} disconnect() {} },
    document: { readyState: 'complete', body: { innerText: 'Open' }, querySelector() {}, addEventListener() {} },
    window: { addEventListener() {} },
    setTimeout(fn, ms) { if (ms === 5000) scheduled = fn; return fn; },
    clearTimeout() {}
  };
  vm.runInNewContext(read('content.js'), context);
  return { messages, mutate: () => mutation(), expire: () => scheduled() };
}
const settle = () => new Promise(setImmediate);
test('a late agreement is completed once it appears, and Proceed waits until enabled', async () => {
  const clicks = [];
  const box = { checked: false, click() { this.checked = true; clicks.push('box'); proceed.disabled = false; } };
  const proceed = { disabled: true, click() { clicks.push('proceed'); } };
  let shown = false;
  const run = agreementRun(() => shown ? { known: true, boxes: [box], proceed } : null);
  await settle();
  assert.deepEqual(clicks, []);
  shown = true;
  run.mutate();
  await settle();
  assert.deepEqual(clicks, ['box', 'proceed']);
  assert.equal(run.messages.find(message => message.type === 'agreement').ok, true);
});
test('unknown checkboxes, a missing popup and a stuck Proceed alert instead of accepting', async () => {
  const clicks = [];
  const box = { checked: false, click() { this.checked = true; clicks.push('box'); } };
  const proceed = { disabled: false, click() { clicks.push('proceed'); } };
  const failure = run => run.messages.find(message => message.type === 'agreement');
  const unknown = agreementRun(() => ({ known: false, boxes: [box], proceed }));
  await settle();
  assert.equal(failure(unknown).ok, false);
  assert.deepEqual(clicks, []);
  const missing = agreementRun(() => null);
  await settle();
  missing.expire();
  await settle();
  assert.match(failure(missing).reason, /did not appear/);
  const stuck = agreementRun(() => ({ known: true, boxes: [box], proceed: { disabled: true, click() { clicks.push('proceed'); } } }));
  await settle();
  stuck.expire();
  await settle();
  assert.match(failure(stuck).reason, /Proceed/);
  assert.deepEqual(clicks, ['box']);
});
test('agreement results update status, and only failures send an alert', async () => {
  const app = background();
  await app.send({ type: 'startAll' });
  await app.send({ type: 'claim' }, app.owner);
  assert.match((await app.send({ type: 'agreement', ok: true }, app.owner)).status, /submitted the Trip Safety Agreement/);
  assert.equal(app.alerts.length, 1);
  assert.match((await app.send({ type: 'agreement', ok: false, reason: 'It did not appear.' }, app.owner)).status, /could not complete/);
  assert.equal(app.alerts.length, 2);
  assert.match(app.alerts[1], /It did not appear/);
});
