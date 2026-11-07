let initialized = false;
let busy = false;
let refreshTimer;
const status = document.getElementById('status');
async function update(message = { type: 'state' }) {
  try {
    const data = await chrome.runtime.sendMessage(message);
    if (data.error) throw Error(data.error);
    if (!initialized) {
      document.getElementById('events').value = data.eventIds.join(', ');
      initialized = true;
    }
    const rows = document.getElementById('watches');
    rows.replaceChildren();
    let running = 0;
    for (const id of data.eventIds) {
      const watch = data.watches[id];
      if (watch?.running) running++;
      const row = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = 'Event ' + id;
      const info = document.createElement('p');
      info.textContent = (watch?.status || 'Stopped') + ' · Background checks: ' + (watch?.checks || 0);
      row.append(title, info);
      const timing = document.createElement('p');
      timing.textContent = watch?.lastCheckAt ? 'Last successful check: ' + new Date(watch.lastCheckAt).toLocaleTimeString() : 'No successful background check yet.';
      if (watch?.nextCheckAt) timing.textContent += ' Next retry: ' + new Date(watch.nextCheckAt).toLocaleTimeString();
      row.append(timing);
      if (watch?.running) {
        const stop = document.createElement('button');
        stop.textContent = 'Stop this event';
        stop.addEventListener('click', () => action({ type: 'stop', eventId: id }));
        row.append(stop);
      }
      rows.append(row);
    }
    status.textContent = running + (running === 1 ? ' event running' : ' events running');
    if (!running) {
      status.textContent += ' — ' + data.eventIds.map(id => id + ': ' + (data.watches[id]?.status || 'Not started, or browser/extension restarted')).join(' · ');
    }
  } catch (error) { status.textContent = error.message; }
}
async function action(message) {
  if (busy) return;
  busy = true;
  document.getElementById('start').disabled = true;
  try { await update(message); }
  finally { busy = false; document.getElementById('start').disabled = false; }
}
document.getElementById('start').addEventListener('click', () => {
  const eventIds = document.getElementById('events').value.trim().split(/[\s,;]+/).filter(Boolean);
  void action({ type: 'startAll', eventIds });
});
document.getElementById('stop').addEventListener('click', () => action({ type: 'stopAll' }));
chrome.storage.onChanged.addListener(() => {
  if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; if (!busy) void update(); }, 500);
});
void update();
