const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8');
const tick = () => new Promise(setImmediate);
function setup({ available = false, pending = false, confirming = false, fail = false, inspectError, transportError } = {}) {
  const messages = [], timers = new Map(), fetches = [];
  let listener, release;
  const context = {
    URL, console: { ...console, warn() {} }, AbortController,
    location: new URL('https://arizonaoutdoorsclub.com/trip-signup/?event_id=6421'),
    document: { readyState: 'complete', body: { innerText: 'Car 8: sam lee FULL' }, querySelector() {}, addEventListener() {} },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    AOCMatcher: { findClaim() { return null; } },
    AOCPoller: { async inspect() { if (inspectError) throw inspectError; return { available }; } },
    async fetch(url, options) {
      fetches.push({ url, options });
      if (fail) { fail = false; throw Error('Network error'); }
      if (pending) await new Promise(resolve => { release = resolve; });
      return {};
    },
    setTimeout(fn, ms) { timers.set(fn, ms); return fn; },
    clearTimeout(fn) { timers.delete(fn); },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) {
        messages.push(message);
        if (message.type === 'state') return { running: true, intervalMs: 100, eventId: '6421', confirming };
        return { ok: true };
      }
    } }
  };
  if (transportError) context.chrome.runtime.sendMessage = transportError;
  vm.runInNewContext(read('content.js'), context);
  return { messages, timers, fetches, runtime: context.chrome.runtime, start: () => listener({ type: 'started' }), stop: () => listener({ type: 'stopped' }), release: () => release(),
    async poll(delay = 100) {
      const entry = [...timers.entries()].find(([, ms]) => ms === delay);
      assert.ok(entry, 'poll scheduled'); timers.delete(entry[0]); entry[0](); await tick();
    }
  };
}
test('full page stays still while sequential authenticated background checks continue', async () => {
  const app = setup(); await tick();
  await app.poll(); await app.poll();
  assert.equal(app.fetches.length, 2);
  assert.equal(app.fetches[0].options.credentials, 'include');
  assert.equal(app.fetches[0].options.cache, 'no-store');
  assert.equal(app.messages.filter(m => m.type === 'checked').length, 2);
  assert.equal(app.messages.some(m => ['candidate', 'reload', 'claim'].includes(m.type)), false);
});
test('invalid context at startup is handled for both API throws and promise rejections', async () => {
  for (const transportError of [
    () => { throw Error('Extension context invalidated.'); },
    () => Promise.reject(Error('Extension context invalidated.'))
  ]) {
    const app = setup({ transportError }); await tick();
    app.start(); await tick();
    assert.equal(app.timers.size, 0);
    assert.equal(app.fetches.length, 0);
  }
});
test('extension reload during polling halts cleanly and cannot claim or schedule another check', async () => {
  const app = setup({ available: true, pending: true }); await tick(); await app.poll();
  let attempts = 0;
  app.runtime.sendMessage = () => { attempts++; throw Error('Extension context invalidated.'); };
  app.release(); await tick();
  assert.equal(app.timers.size, 0);
  assert.equal(app.fetches[0].options.signal.aborted, true);
  assert.equal(app.messages.some(m => m.type === 'candidate'), false);
  app.start(); await tick();
  assert.equal(attempts, 1);
});
test('a candidate requests one verification load and stops polling', async () => {
  const app = setup({ available: true }); await tick(); await app.poll();
  assert.equal(app.messages.filter(m => m.type === 'candidate').length, 1);
  assert.equal(app.timers.size, 0);
});
test('Stop aborts an in-flight check and discards its late candidate result', async () => {
  const app = setup({ available: true, pending: true }); await tick(); await app.poll();
  assert.equal([...app.timers.values()].includes(100), false);
  app.stop();
  assert.equal(app.fetches[0].options.signal.aborted, true);
  app.release(); await tick();
  assert.equal(app.messages.some(m => m.type === 'candidate'), false);
  assert.equal(app.timers.size, 0);
});
test('missing live candidate resumes silent checking instead of stopping', async () => {
  const app = setup({ confirming: true }); await tick();
  assert.ok(app.messages.some(m => m.type === 'candidateMissed'));
  await app.poll();
  assert.ok(app.messages.some(m => m.type === 'checked'));
});
test('network errors retry and return to normal checking after recovery', async () => {
  const app = setup({ fail: true }); await tick(); await app.poll();
  assert.ok(app.messages.some(m => m.type === 'retrying' && m.delayMs === 1000));
  await app.poll(1000);
  assert.ok(app.messages.some(m => m.type === 'checked'));
  assert.ok([...app.timers.values()].includes(100));
});
test('repeated server failures back off and Stop cancels the next retry', async () => {
  const error = Object.assign(Error('HTTP 503'), { retryable: true });
  const app = setup({ inspectError: error }); await tick(); await app.poll(); await app.poll(1000);
  assert.ok(app.messages.some(m => m.type === 'retrying' && m.delayMs === 2000));
  app.stop(); assert.equal(app.timers.size, 0);
});
test('server retry delay is respected and nonretryable errors still pause', async () => {
  const app = setup({ inspectError: Object.assign(Error('HTTP 429'), { retryable: true, retryAfterMs: 120000 }) });
  await tick(); await app.poll();
  assert.ok([...app.timers.values()].includes(120000));
  const blocked = setup({ inspectError: Error('Login required') }); await tick(); await blocked.poll();
  assert.ok(blocked.messages.some(m => m.type === 'pause'));
  assert.equal(blocked.timers.size, 0);
});
function inspector({ text = 'Car 8: sam lee Driver: sam lee Contact: hidden', login = false, available = false } = {}) {
  const context = {
    URL,
    DOMParser: class { parseFromString() { return { body: { textContent: text }, querySelector() { return login; } }; } },
    AOCMatcher: { readText: element => element.textContent, findClaim(doc, id, options) { assert.equal(id, '6421'); assert.equal(options.rendered, false); return available; } }
  };
  vm.runInNewContext(read('poller.js'), context);
  const response = { ok: true, status: 200, url: 'https://arizonaoutdoorsclub.com/trip-signup/?event_id=6421', headers: { get() { return 'text/html'; } }, async text() { return '<html></html>'; } };
  return { inspect: overrides => context.AOCPoller.inspect({ ...response, ...overrides }, '6421') };
}
test('response validation rejects redirects, rate limits, challenges, logins, and absent availability', async () => {
  await assert.rejects(inspector().inspect({ ok: false, status: 429 }), /HTTP 429/);
  await assert.rejects(inspector().inspect({ url: 'https://arizonaoutdoorsclub.com/login/' }), /redirected/);
  await assert.rejects(inspector({ text: 'Enable JavaScript and cookies to continue' }).inspect(), /challenge/);
  await assert.rejects(inspector({ login: true }).inspect(), /Login required/);
  await assert.rejects(inspector({ text: 'Loading...' }).inspect(), /availability is missing/);
  assert.equal((await inspector({ available: true }).inspect()).available, true);
  assert.equal((await inspector().inspect()).available, false);
});
test('HTTP error classification retries temporary failures and honors Retry-After', async () => {
  for (const status of [408, 500, 502, 503]) {
    await assert.rejects(inspector().inspect({ ok: false, status }), error => error.retryable === true);
  }
  await assert.rejects(inspector().inspect({ ok: false, status: 429, headers: { get: () => '120' } }),
    error => error.retryable === true && error.retryAfterMs === 120000);
  for (const status of [401, 403, 404]) {
    await assert.rejects(inspector().inspect({ ok: false, status }), error => error.retryable === false);
  }
});
