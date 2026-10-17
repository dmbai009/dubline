const test = require('node:test');
const assert = require('node:assert/strict');
const { clientVersion, mismatch } = require('../src/public/guest-version');
const ua = version => 'Mozilla/5.0 Dubline/' + version + ' Chrome/152.0 Electron/44.5.0 Safari/537.36';
test('guest version detection supports existing Electron builds and both directions of stable/beta mismatches', () => {
  assert.equal(clientVersion(ua('1.3.0')), '1.3.0');
  assert.equal(mismatch(ua('1.4.0'), '1.4.0'), null);
  assert.deepEqual(mismatch(ua('1.3.0'), '1.4.0-beta.1'), { guest: '1.3.0', host: '1.4.0-beta.1' });
  assert.deepEqual(mismatch(ua('1.4.0-beta.2'), '1.4.0-beta.1'), { guest: '1.4.0-beta.2', host: '1.4.0-beta.1' });
  assert.deepEqual(mismatch(ua('1.4.0'), '1.3.9'), { guest: '1.4.0', host: '1.3.9' });
  for (const agent of ['', 'Chrome/152.0', 'Electron/44.5.0', 'Dubline/1.4.0 Chrome/152.0', ua('<script>'), ua('1.'.repeat(80))]) assert.equal(mismatch(agent, '1.4.0'), null);
  for (const version of ['', null, {}, '<img>', 'a'.repeat(100)]) assert.equal(mismatch(ua('1.3.0'), version), null);
});
