(() => {
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  function readText(element) {
    if (!element) return '';
    if (element.ownerDocument?.defaultView && element.innerText) return element.innerText;
    if (!element.ownerDocument?.createTreeWalker) return element.textContent || '';
    const walker = element.ownerDocument.createTreeWalker(element, 4);
    const parts = [];
    while (walker.nextNode()) {
      if (!walker.currentNode.parentElement?.closest('script, style, template')) parts.push(walker.currentNode.nodeValue);
    }
    return parts.join(' ');
  }
  const isEligible = (element, eventId, options = {}) => {
      const labels = [element.innerText || element.textContent, element.value, element.getAttribute('aria-label')];
      if (!labels.some(label => ['claim passenger spot', 'claim spot'].includes(normalize(label)))) return false;
      if (element.disabled || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true' || element.closest('[inert]')) return false;
      if (options.rendered === false) {
        // Detached response HTML has no layout. This is only a signal to load
        // the real page; a visible, enabled control is still required to click.
        if (element.closest('[hidden], [aria-hidden="true"]')) return false;
        return true;
      }
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
  };
  const findClaim = (root, eventId, options) => Array.from(root.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"]'))
    .find(element => isEligible(element, eventId, options));
  const AGREEMENT_TEXT = 'i acknowledge that i am entirely responsible for my own preparation and safety';
  const findAgreement = root => {
    const popup = root.querySelector('#aoc-attendee-safety-popup');
    if (!popup || !popup.getClientRects().length) return null;
    const boxes = Array.from(popup.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
    // Only the known acknowledgement may be ticked automatically; new terms need the user.
    const known = boxes.length > 0 && boxes.every(box => normalize(box.closest('label')?.textContent).startsWith(AGREEMENT_TEXT));
    const proceed = Array.from(popup.querySelectorAll('button')).find(button => normalize(button.textContent) === 'proceed');
    return { boxes, known, proceed };
  };
  globalThis.AOCMatcher = { findAgreement, findClaim, isEligible, normalize, readText };
})();
