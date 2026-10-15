// The browser suite may skip local runs without Chrome or Edge, but CI must fail
// loudly rather than report a green run with every browser test skipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireBrowser } = require('../e2e/helpers');

test('a missing browser is fatal when DUBLINE_REQUIRE_BROWSER=1 and skippable otherwise', () => {
  assert.doesNotThrow(() => requireBrowser('/usr/bin/google-chrome', { DUBLINE_REQUIRE_BROWSER: '1' }));
  assert.doesNotThrow(() => requireBrowser(null, {}));
  assert.doesNotThrow(() => requireBrowser(null, { DUBLINE_REQUIRE_BROWSER: '0' }));
  assert.throws(() => requireBrowser(null, { DUBLINE_REQUIRE_BROWSER: '1' }), /Chrome\/Edge not found.*DUBLINE_REQUIRE_BROWSER/s);
});
