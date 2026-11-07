const INITIAL = { running: false, tabId: null, intervalMs: 100, status: 'Stopped', checks: 0, confirming: false };
const eventUrl = id => 'https://arizonaoutdoorsclub.com/trip-signup/?event_id=' + id;
let queue = Promise.resolve();
function eventFromUrl(value) {
  try {
    const url = new URL(value);
    const id = url.searchParams.get('event_id');
    return url.origin === 'https://arizonaoutdoorsclub.com' && url.pathname === '/trip-signup/' && /^[1-9]\d*$/.test(id || '') ? id : null;
  } catch { return null; }
}
function validateIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id))) {
    throw Error('Enter event IDs separated by commas or new lines, for example: 6421, 6228.');
  }
  return [...new Set(ids)];
}
async function watches() { return (await chrome.storage.session.get('watches')).watches || {}; }
async function configured() { return (await chrome.storage.local.get('eventIds')).eventIds || ['6421']; }
async function save(all) {
  await chrome.storage.session.set({ watches: all });
  const count = Object.values(all).filter(w => w.running).length;
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}
async function summary() { return { eventIds: await configured(), watches: await watches() }; }
async function notifyStopped(watch) {
  try {
    await chrome.notifications.create('aoc-stop-' + watch.eventId, {
      type: 'basic',
      iconUrl: 'notification.png',
      title: `AOC watcher stopped — event ${watch.eventId}`,
      message: watch.status,
      priority: 2,
      requireInteraction: true
    });
  } catch (error) {
    console.error('Could not display watcher stop notification:', error);
  }
}
async function stop(all, id, status = 'Stopped by you') {
  const watch = all[id];
  if (!watch) return;
  const wasRunning = watch.running;
  const wasClaiming = watch.status === 'Matching claim button detected; click authorized';
  watch.running = false;
  watch.status = status;
  watch.stoppedAt = new Date().toISOString();
  watch.nextCheckAt = null;
  await save(all);
  if (wasRunning || wasClaiming) await notifyStopped(watch);
  if (watch.tabId !== null) await chrome.tabs.sendMessage(watch.tabId, { type: 'stopped' }).catch(() => {});
}
async function startEvent(all, id, existingTabs) {
  if (all[id]?.running) return;
  let tab;
  try {
    tab = existingTabs.find(item => eventFromUrl(item.url) === id);
    if (!tab) tab = await chrome.tabs.create({ url: eventUrl(id), active: false });
    all[id] = { ...INITIAL, eventId: id, tabId: tab.id, running: true, status: 'Checking silently for CLAIM PASSENGER SPOT or CLAIM SPOT' };
    await save(all);
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
    await chrome.tabs.sendMessage(tab.id, { type: 'started' }).catch(() => chrome.tabs.reload(tab.id));
  } catch (error) {
    all[id] = { ...INITIAL, eventId: id, tabId: tab?.id ?? null, status: 'Could not start: ' + error.message };
    await save(all);
    await notifyStopped(all[id]);
  }
}
async function handle(message, sender) {
  const all = await watches();
  const fromPopup = !sender.tab && sender.id === chrome.runtime.id;
  const watch = Object.values(all).find(item => item.tabId === sender.tab?.id);
  if (message.type === 'state') return fromPopup ? summary() : watch || { ...INITIAL };
  if (message.type === 'startAll' || message.type === 'start') {
    const launcher = message.type === 'start' && message.launcher === true && eventFromUrl(sender.url);
    if (!fromPopup && !launcher) return { error: 'Wrong page' };
    if (!fromPopup && message.eventIds !== undefined) return { error: 'Use the extension popup to edit events' };
    const ids = validateIds(message.eventIds === undefined ? await configured() : message.eventIds);
    await chrome.storage.local.set({ eventIds: ids });
    for (const id of Object.keys(all)) {
      if (!ids.includes(id)) { await stop(all, id, 'Removed from list'); delete all[id]; }
    }
    await save(all);
    const tabs = await chrome.tabs.query({ url: 'https://arizonaoutdoorsclub.com/trip-signup/*' });
    for (const id of ids) await startEvent(all, id, tabs);
    return summary();
  }
  if (message.type === 'stopAll' && fromPopup) {
    for (const id of Object.keys(all)) await stop(all, id);
    return summary();
  }
  if (message.type === 'stop' && fromPopup) {
    await stop(all, message.eventId);
    return summary();
  }
  if (!watch) return { error: 'Not a watched tab' };
  if (message.type === 'stop' || message.type === 'pause') {
    await stop(all, watch.eventId, message.type === 'pause' ? String(message.reason || 'Paused') : 'Stopped by you');
    return watch;
  }
  if (message.type === 'claim') {
    if (!watch.running || eventFromUrl(sender.url) !== watch.eventId) return { click: false };
    watch.running = false;
    watch.status = 'Matching claim button detected; click authorized';
    watch.detectedAt = new Date().toISOString();
    await save(all);
    // Dispatch without delaying the claim click on desktop notification delivery.
    void notifyStopped({ ...watch, status: 'Matching spot detected; watcher stopped to attempt the claim. Check the event page to confirm the reservation.' });
    return { click: true };
  }
  if (message.type === 'clicked') {
    watch.status = 'Clicked the matching claim button once. Check the page to confirm your reservation.';
    await save(all);
    return watch;
  }
  if (message.type === 'agreement' && eventFromUrl(sender.url) === watch.eventId) {
    watch.status = message.ok
      ? 'Clicked the claim button and submitted the Trip Safety Agreement. Check the page to confirm your reservation.'
      : `Clicked the claim button, but could not complete the Trip Safety Agreement. ${String(message.reason || '')} Finish it on the page now.`;
    await save(all);
    if (!message.ok) await notifyStopped(watch);
    return watch;
  }
  if (message.type === 'checked' && watch.running && eventFromUrl(sender.url) === watch.eventId) {
    watch.checks++;
    watch.lastCheckAt = new Date().toISOString();
    watch.nextCheckAt = null;
    watch.status = 'Checking silently for CLAIM PASSENGER SPOT or CLAIM SPOT';
    await save(all);
    return { ok: true };
  }
  if (message.type === 'retrying' && watch.running && eventFromUrl(sender.url) === watch.eventId) {
    const delayMs = Math.max(1000, Math.min(Number(message.delayMs) || 1000, 2147483647));
    watch.lastError = String(message.reason || 'Temporary request failure');
    watch.nextCheckAt = new Date(Date.now() + delayMs).toISOString();
    watch.status = `${watch.lastError} Retrying automatically in ${Math.ceil(delayMs / 1000)}s.`;
    await save(all);
    return { ok: true };
  }
  if (message.type === 'candidate' && watch.running && !watch.confirming && eventFromUrl(sender.url) === watch.eventId) {
    if (Date.now() < (watch.candidateCooldownUntil || 0)) return { ok: false };
    watch.confirming = true;
    watch.status = 'Matching spot detected. Loading once to verify and click.';
    await save(all);
    await chrome.tabs.reload(watch.tabId, { bypassCache: true });
    return { ok: true };
  }
  if (message.type === 'candidateMissed' && watch.running && eventFromUrl(sender.url) === watch.eventId) {
    watch.confirming = false;
    watch.candidateCooldownUntil = Date.now() + 30000;
    watch.status = 'Spot not actionable after loading. Silent checks resumed; verification reloads paused for 30s.';
    await save(all);
    return { ok: true };
  }
  return { ok: false };
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  queue = queue.then(() => handle(message, sender)).then(reply, error => reply({ error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  queue = queue.then(async () => {
    const all = await watches();
    for (const watch of Object.values(all)) {
      if (watch.tabId === tabId) {
        watch.tabId = null;
        await stop(all, watch.eventId, 'Watched tab closed');
      }
    }
    await save(all);
  }).catch(console.error);
});
