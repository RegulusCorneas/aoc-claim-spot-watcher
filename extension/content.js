(() => {
  let active = false;
  let claiming = false;
  let timer;
  let observer;
  let request;
  let intervalMs = 100;
  let eventId;
  let generation = 0;
  let confirming = false;
  let pollRunning = false;
  let failures = 0;
  let nextDelay = 100;
  let disconnected = false;
  const pageEvent = () => location.pathname === '/trip-signup/' ? new URL(location.href).searchParams.get('event_id') : null;
  const target = () => pageEvent() === eventId;
  async function send(message) {
    const stopped = { running: false, click: false, ok: false, error: 'Extension connection lost. Refresh this event tab and start the watcher again.' };
    if (disconnected) return stopped;
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response) throw Error('No response from extension');
      return response;
    } catch (error) {
      // Reloading/disabling the extension invalidates scripts in existing tabs.
      // Catch both synchronous API throws and rejected messaging promises.
      disconnected = true;
      halt();
      console.warn('AOC watcher disconnected. Refresh this event tab, then start watching again.');
      return stopped;
    }
  }
  function halt() {
    generation++;
    active = false;
    clearTimeout(timer);
    request?.abort();
    request = null;
    observer?.disconnect();
  }
  async function pause(reason) {
    halt();
    await send({ type: 'pause', reason });
  }
  function waitFor(find, ms) {
    const found = find();
    if (found) return Promise.resolve(found);
    return new Promise(resolve => {
      const finish = value => {
        clearTimeout(limit);
        watcher.disconnect();
        resolve(value);
      };
      // Observers keep firing promptly in background tabs, where timers are throttled.
      const watcher = new MutationObserver(() => {
        const value = find();
        if (value) finish(value);
      });
      watcher.observe(document, { subtree: true, childList: true, attributes: true });
      const limit = setTimeout(() => finish(null), ms);
    });
  }
  async function completeAgreement() {
    const fail = reason => send({ type: 'agreement', ok: false, reason });
    const agreement = await waitFor(() => AOCMatcher.findAgreement(document), 5000);
    if (!agreement) return fail('It did not appear.');
    if (!agreement.known) return fail('It has a checkbox the watcher does not recognize.');
    for (const box of agreement.boxes) if (!box.checked) box.click();
    const proceed = await waitFor(() => {
      const button = AOCMatcher.findAgreement(document)?.proceed;
      return button && !button.disabled ? button : null;
    }, 5000);
    if (!proceed) return fail('Proceed did not become available.');
    // Proceed submits and reloads the page, so report first without delaying the click.
    void send({ type: 'agreement', ok: true });
    proceed.click();
  }
  async function scan() {
    if (!active || claiming) return false;
    const button = AOCMatcher.findClaim(document, eventId);
    if (!button) return false;
    claiming = true;
    clearTimeout(timer);
    request?.abort();
    observer?.disconnect();
    const attempt = generation;
    try {
      const permission = await send({ type: 'claim' });
      if (attempt !== generation || !active) return true;
      halt();
      if (permission.click) {
        if (!target() || !button.isConnected || !AOCMatcher.isEligible(button, eventId)) {
          await send({ type: 'pause', reason: 'Claim button or car changed before click. Start again to retry.' });
        } else {
          button.click();
          await Promise.all([send({ type: 'clicked' }), completeAgreement()]);
        }
      }
    } catch (error) { halt(); console.error('AOC watcher stopped:', error); }
    return true;
  }
  function schedule() {
    if (!active || claiming) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void poll(); }, nextDelay);
  }
  async function poll() {
    if (!active || claiming || pollRunning) return;
    const attempt = generation;
    pollRunning = true;
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      if (!target()) throw Error('Left the signup page. Restart on the correct event.');
      const response = await fetch(location.origin + location.pathname + location.search, {
        credentials: 'include', cache: 'no-store', signal: controller.signal
      }).catch(error => {
        error.retryable = true;
        throw error;
      });
      const result = await AOCPoller.inspect(response, eventId);
      if (attempt !== generation || !active || claiming) return;
      if (await scan() || attempt !== generation || !active || claiming) return;
      await send({ type: 'checked' });
      if (attempt !== generation || !active || claiming) return;
      failures = 0;
      nextDelay = intervalMs;
      if (result.available) {
        // Load only on a candidate, then use the site's actual rendered control.
        const result = await send({ type: 'candidate' });
        if (result.error) throw Error(result.error);
        if (attempt === generation && result.ok) halt();
      }
    } catch (error) {
      if (attempt === generation && active && !claiming) {
        if (error.retryable || error.name === 'AbortError') {
          failures++;
          nextDelay = Math.max(Math.min(1000 * 2 ** Math.min(failures - 1, 6), 60000), error.retryAfterMs || 0);
          const reason = error.name === 'AbortError' ? 'Background check timed out' : error.message;
          await send({ type: 'retrying', reason, delayMs: nextDelay }).catch(console.error);
        } else {
          await pause(error.message);
        }
      }
    } finally {
      clearTimeout(timeout);
      if (request === controller) request = null;
      pollRunning = false;
      if (active && !claiming) schedule();
    }
  }
  async function afterLoad() {
    if (!active || claiming) return;
    if (!target()) return pause('Left the signup page. Check your login or reservation before restarting.');
    const text = document.body?.innerText || '';
    if (/too many requests|rate limit exceeded|access denied|verify you are human|checking your browser|enable javascript and cookies to continue/i.test(text)) {
      return pause('Site returned a rate limit or access challenge. Check the page before restarting.');
    }
    if (document.querySelector('input[type="password"]')) return pause('Login required. Sign in, then start again.');
    if (await scan() || !active || claiming) return;
    if (confirming) {
      await send({ type: 'candidateMissed' });
      confirming = false;
    }
    schedule();
  }
  async function start() {
    halt();
    const attempt = generation;
    const watch = await send({ type: 'state' });
    if (attempt !== generation || !watch.running) return;
    eventId = watch.eventId;
    confirming = Boolean(watch.confirming);
    if (!target()) return pause('Left the signup page. Check your login or reservation before restarting.');
    active = true;
    claiming = false;
    intervalMs = watch.intervalMs;
    failures = 0;
    nextDelay = intervalMs;
    observer = new MutationObserver(() => { void scan(); });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    await scan();
    if (document.readyState === 'complete') await afterLoad();
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'stopped') halt();
    if (message.type === 'started') void start();
  });
  window.addEventListener('load', () => { void afterLoad(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) { halt(); void send({ type: 'stop' }); }
  });
  if (/^[1-9]\d*$/.test(pageEvent() || '') && location.hash === '#aoc-watch-start') {
    history.replaceState(null, '', location.pathname + location.search);
    void send({ type: 'start', launcher: true }).then(start);
  } else { void start(); }
})();
