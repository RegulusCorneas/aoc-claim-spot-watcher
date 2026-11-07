(() => {
  async function inspect(response, eventId) {
    if (!response.ok) {
      const error = Error(`Background check returned HTTP ${response.status}.`);
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const retryAfter = response.headers.get('retry-after');
      const wait = retryAfter && (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now());
      error.retryAfterMs = Math.max(0, Number.isFinite(wait) ? wait : 0, response.status === 429 ? 60000 : 0);
      if (error.retryAfterMs > 2147483647) error.retryable = false;
      throw error;
    }
    const url = new URL(response.url);
    if (url.origin !== 'https://arizonaoutdoorsclub.com' || url.pathname !== '/trip-signup/' || url.searchParams.get('event_id') !== eventId) {
      throw Error('Background check was redirected. Check your login before restarting.');
    }
    if (!(response.headers.get('content-type') || '').includes('text/html')) throw Error('Background check did not return a signup page.');
    const html = await response.text().catch(error => { error.retryable = true; throw error; });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Inspect only inert HTML. Never execute scripts or submit fetched forms.
    const text = AOCMatcher.readText(doc.body);
    if (/too many requests|rate limit exceeded|access denied|verify you are human|checking your browser|enable javascript and cookies to continue/i.test(text)) {
      throw Error('Background check hit a rate limit or access challenge. Check the site before restarting.');
    }
    if (doc.querySelector('input[type="password"]')) throw Error('Login required. Sign in, then start again.');
    if (!/\bcar\s+\d+\s*:/i.test(text) || !/\bdriver\s*:/i.test(text)) {
      throw Error('Car availability is missing from the background response. Silent checking cannot verify this page.');
    }
    return { available: Boolean(AOCMatcher.findClaim(doc, eventId, { rendered: false })) };
  }
  globalThis.AOCPoller = { inspect };
})();
