const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function setup() {
  let listener, removed;
  const session = {}, local = {}, reloads = [], notifications = [], alerts = [];
  const tabs = [{ id: 1, url: 'https://arizonaoutdoorsclub.com/trip-signup/?event_id=6421' }];
  const area = data => ({ async get() { return structuredClone(data); }, async set(value) { Object.assign(data, structuredClone(value)); } });
  const chrome = {
    runtime: { id: 'extension', onMessage: { addListener(fn) { listener = fn; } } },
    storage: { session: area(session), local: area(local) },
    action: { async setBadgeText() {} },
    notifications: { async create(id, options) { alerts.push({ id, ...options }); } },
    tabs: {
      async query() { return structuredClone(tabs); },
      async create(options) { const tab = { id: tabs.length + 1, url: options.url }; tabs.push(tab); return tab; },
      async update() {},
      async sendMessage(id, message) { notifications.push([id, message.type]); },
      async reload(id) { reloads.push(id); },
      onRemoved: { addListener(fn) { removed = fn; } }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), { chrome, URL, console });
  const send = (message, tab) => new Promise(resolve => listener(message, tab ? { id: 'extension', tab, url: tab.url } : { id: 'extension' }, resolve));
  return { send, tabs, reloads, notifications, alerts, local, session, removed, chrome };
}
test('two events check without reloading and simultaneous claims authorize once per event', async () => {
  const app = setup();
  const started = await app.send({ type: 'startAll', eventIds: ['6421', '6228', '6421'] });
  assert.equal(app.tabs.length, 2);
  assert.equal(started.eventIds.length, 2);
  await Promise.all(app.tabs.map(tab => app.send({ type: 'checked' }, tab)));
  assert.deepEqual(app.reloads, []);
  const results = await Promise.all([
    app.send({ type: 'claim' }, app.tabs[0]),
    app.send({ type: 'claim' }, app.tabs[1]),
    app.send({ type: 'claim' }, app.tabs[0])
  ]);
  assert.deepEqual(results.map(result => result.click), [true, true, false]);
  await Promise.all(app.tabs.map(tab => app.send({ type: 'checked' }, tab)));
  assert.deepEqual(app.reloads, []);
});
test('claiming one event leaves other events watching', async () => {
  const app = setup();
  await app.send({ type: 'startAll', eventIds: ['6421', '6228'] });
  await app.send({ type: 'claim' }, app.tabs[0]);
  await app.send({ type: 'checked' }, app.tabs[1]);
  const state = await app.send({ type: 'state' });
  assert.equal(state.watches['6421'].running, false);
  assert.equal(state.watches['6228'].running, true);
  assert.deepEqual(app.reloads, []);
});
test('individual stop and closing a tab do not stop other events; stop all does', async () => {
  const app = setup();
  await app.send({ type: 'startAll', eventIds: ['6421', '6228'] });
  await app.send({ type: 'stop', eventId: '6421' });
  assert.equal((await app.send({ type: 'state' })).watches['6228'].running, true);
  await app.send({ type: 'startAll' });
  app.removed(1);
  const state = await app.send({ type: 'state' });
  assert.equal(state.watches['6421'].running, false);
  assert.equal(state.watches['6228'].running, true);
  await app.send({ type: 'stopAll' });
  assert.ok(Object.values((await app.send({ type: 'state' })).watches).every(w => !w.running));
});
test('editing list stops removed events, preserves running event, and rejects invalid IDs atomically', async () => {
  const app = setup();
  await app.send({ type: 'startAll', eventIds: ['6421', '6228'] });
  await app.send({ type: 'checked' }, app.tabs[1]);
  assert.ok((await app.send({ type: 'startAll', eventIds: ['6228', 'invalid'] })).error);
  assert.equal((await app.send({ type: 'state' })).eventIds.length, 2);
  const state = await app.send({ type: 'startAll', eventIds: ['6228'] });
  assert.equal(state.watches['6421'], undefined);
  assert.equal(state.watches['6228'].checks, 1);
  assert.ok(app.notifications.some(([id, type]) => id === 1 && type === 'stopped'));
  assert.ok((await app.send({ type: 'claim' }, app.tabs[0])).error);
});
test('launcher starts saved list and event list survives cleared runtime state', async () => {
  const app = setup();
  await app.send({ type: 'startAll', eventIds: ['6228', '1234'] });
  delete app.session.watches;
  const idle = await app.send({ type: 'state' });
  assert.equal(Object.keys(idle.watches).length, 0);
  const started = await app.send({ type: 'start', launcher: true }, app.tabs[0]);
  assert.equal(started.watches['6421'], undefined);
  assert.equal(started.watches['6228'].running, true);
  assert.equal(started.watches['1234'].running, true);
  assert.equal(app.tabs.length, 3);
});
test('a watched tab cannot claim a different event or overwrite the saved list', async () => {
  const app = setup();
  await app.send({ type: 'startAll', eventIds: ['6421', '6228'] });
  const changedTab = { ...app.tabs[0], url: app.tabs[1].url };
  assert.equal((await app.send({ type: 'claim' }, changedTab)).click, false);
  assert.ok((await app.send({ type: 'start', launcher: true, eventIds: ['9999'] }, app.tabs[0])).error);
});
test('candidate reloads only its own tab once and stops cannot trigger reloads', async () => {
  const app = setup();
  await app.send({ type: 'startAll', eventIds: ['6421', '6228'] });
  await app.send({ type: 'candidate' }, app.tabs[0]);
  await app.send({ type: 'candidate' }, app.tabs[0]);
  assert.deepEqual(app.reloads, [1]);
  const state = await app.send({ type: 'state' });
  assert.equal(state.watches['6421'].confirming, true);
  assert.equal(state.watches['6228'].confirming, false);
  await app.send({ type: 'stopAll' });
  await app.send({ type: 'candidate' }, app.tabs[1]);
  assert.deepEqual(app.reloads, [1]);
});
test('retry status keeps watching, records diagnostics and clears on a successful check', async () => {
  const app = setup();
  await app.send({ type: 'startAll', eventIds: ['6421'] });
  await app.send({ type: 'retrying', reason: 'HTTP 503', delayMs: 2000 }, app.tabs[0]);
  let watch = (await app.send({ type: 'state' })).watches['6421'];
  assert.equal(watch.running, true);
  assert.match(watch.status, /Retrying automatically/);
  assert.ok(Date.parse(watch.nextCheckAt) > Date.now());
  await app.send({ type: 'checked' }, app.tabs[0]);
  watch = (await app.send({ type: 'state' })).watches['6421'];
  assert.ok(watch.lastCheckAt);
  assert.equal(watch.nextCheckAt, null);
  assert.match(watch.status, /Checking silently/);
});
test('lost candidate resumes checks and suppresses repeated verification reloads during cooldown', async () => {
  const app = setup();
  await app.send({ type: 'startAll', eventIds: ['6421'] });
  await app.send({ type: 'candidate' }, app.tabs[0]);
  await app.send({ type: 'candidateMissed' }, app.tabs[0]);
  await app.send({ type: 'candidate' }, app.tabs[0]);
  await app.send({ type: 'checked' }, app.tabs[0]);
  const watch = (await app.send({ type: 'state' })).watches['6421'];
  assert.equal(watch.running, true);
  assert.equal(watch.confirming, false);
  assert.equal(watch.checks, 1);
  assert.deepEqual(app.reloads, [1]);
});
test('pause sends an event-specific desktop alert once; retries remain quiet', async () => {
  const app = setup();
  await app.send({ type: 'startAll', eventIds: ['6421', '6228'] });
  await app.send({ type: 'retrying', reason: 'HTTP 503', delayMs: 1000 }, app.tabs[0]);
  assert.equal(app.alerts.length, 0);
  await app.send({ type: 'pause', reason: 'Login required' }, app.tabs[0]);
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0].title, /6421/);
  assert.equal(app.alerts[0].message, 'Login required');
  await app.send({ type: 'stop', eventId: '6421' });
  assert.equal(app.alerts.length, 1);
  assert.equal((await app.send({ type: 'state' })).watches['6228'].running, true);
});
test('manual stop, closed tab and claim attempt send accurate stop alerts', async () => {
  const app = setup();
  await app.send({ type: 'startAll', eventIds: ['6421', '6228', '1234'] });
  await app.send({ type: 'stop', eventId: '6421' });
  app.removed(2);
  await app.send({ type: 'claim' }, app.tabs[2]);
  assert.equal(app.alerts.length, 3);
  assert.equal(app.alerts[0].message, 'Stopped by you');
  assert.equal(app.alerts[1].message, 'Watched tab closed');
  assert.match(app.alerts[2].message, /attempt the claim/);
  assert.match(app.alerts[2].message, /confirm the reservation/);
});
test('desktop notification failure cannot prevent stopping or break other watchers', async () => {
  const app = setup();
  app.chrome.notifications.create = async () => { throw Error('Notifications disabled'); };
  await app.send({ type: 'startAll', eventIds: ['6421', '6228'] });
  await app.send({ type: 'pause', reason: 'Login required' }, app.tabs[0]);
  await app.send({ type: 'checked' }, app.tabs[1]);
  const watches = (await app.send({ type: 'state' })).watches;
  assert.equal(watches['6421'].running, false);
  assert.equal(watches['6228'].checks, 1);
});
