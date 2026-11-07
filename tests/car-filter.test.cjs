const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/matcher.js'), 'utf8'), context);
const matcher = context.AOCMatcher;
function button(driver) {
  return { innerText: 'CLAIM PASSENGER SPOT', parentElement: { textContent: 'Car 1: ' + driver }, disabled: false,
    getAttribute: () => null, matches: () => false, closest: () => null, getClientRects: () => [{}] };
}
for (const eventId of ['6421', '6228']) {
  test(eventId + ' allows any driver in live and background checks', () => {
    for (const driver of ['Other Driver', 'sam lee']) {
      const claim = button(driver);
      assert.equal(matcher.isEligible(claim, eventId), true);
      assert.equal(matcher.isEligible(claim, eventId, { rendered: false }), true);
    }
  });
}
test('6421 chooses first eligible passenger button regardless of car', () => {
  const first = button('Other Driver');
  const second = button('sam lee');
  assert.equal(matcher.findClaim({ querySelectorAll: () => [first, second] }, '6421'), first);
  first.disabled = true;
  assert.equal(matcher.findClaim({ querySelectorAll: () => [first, second] }, '6421'), second);
});
