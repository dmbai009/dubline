// CI must fail when no browser is installed instead of skipping every browser
// suite and still reporting success. The preflight tool decides that, and its
// rule must not depend on the machine running the tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { browserRequired } = require('../tools/require-browser');

test('a missing browser is fatal for CI and only for CI', () => {
  assert.equal(browserRequired('/usr/bin/google-chrome', { DUBLINE_REQUIRE_BROWSER: '1' }), false, 'an installed browser satisfies CI');
  assert.equal(browserRequired(null, {}), false, 'local runs may skip without a browser');
  assert.equal(browserRequired(null, { DUBLINE_REQUIRE_BROWSER: '0' }), false, 'an explicit 0 keeps skipping allowed');
  assert.equal(browserRequired(null, { DUBLINE_REQUIRE_BROWSER: '1' }), true, 'CI without a browser must be refused');
});
