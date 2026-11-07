(async () => {
  const results = [];
  const car = (name, button = true) => `<section><h2>Car 8: ${name} FULL</h2><div><p>Driver: <span>♛</span> ${name}</p><p>Contact: hidden</p><table><tr><td>${button ? '<button>CLAIM PASSENGER SPOT</button>' : 'No open spots'}</td></tr></table></div></section>`;
  const check = async (name, html, eventId, expected) => {
    const result = await AOCPoller.inspect({ ok: true, status: 200,
      url: 'https://arizonaoutdoorsclub.com/trip-signup/?event_id=' + eventId,
      headers: new Headers({ 'content-type': 'text/html' }), text: async () => html
    }, eventId);
    if (result.available !== expected) throw Error(name + ': unexpected match');
    results.push('PASS: ' + name);
  };
  try {
    await check('Any open car qualifies for event 6421', car('other driver') + car('sam lee', false), '6421', true);
    await check('Second car opening is detected from detached HTML', car('other driver') + car('sam lee'), '6421', true);
    await check('Other events allow any driver', car('other driver'), '6228', true);
    await check('Explicitly hidden claim is ignored', car('sam lee').replace('<button>', '<button hidden>'), '6421', false);
    await check('Disabled claim is ignored', car('sam lee').replace('<button>', '<button disabled>'), '6421', false);
    await check('No open spots yields no candidate', car('sam lee', false), '6421', false);
    document.getElementById('result').textContent = results.join('\n') + '\n6/6 passed in browser. No requests sent to AOC.';
  } catch (error) { document.getElementById('result').textContent = results.join('\n') + '\nFAIL: ' + error.message; }
})();
