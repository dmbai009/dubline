const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, isNewerVersion, evaluateRelease } = require('../electron-update');

test('update versions are compared numerically', () => {
  assert.deepEqual(parseVersion('v1.12.3'), [1, 12, 3]);
  assert.equal(isNewerVersion('v1.10.0', '1.9.9'), true);
  assert.equal(isNewerVersion('1.0.1', '1.0.1'), false);
  assert.equal(isNewerVersion('0.9.9', '1.0.0'), false);
  assert.equal(isNewerVersion('nightly', '1.0.0'), false);
});

test('only stable newer releases produce a fixed GitHub download page', () => {
  assert.deepEqual(evaluateRelease({ tag_name: 'v1.1.0', draft: false, prerelease: false }, '1.0.1'), {
    version: '1.1.0',
    url: 'https://github.com/dmbai009/dubline/releases/tag/v1.1.0'
  });
  assert.equal(evaluateRelease({ tag_name: 'v2.0.0', draft: true }, '1.0.1'), null);
  assert.equal(evaluateRelease({ tag_name: 'v2.0.0', prerelease: true }, '1.0.1'), null);
  assert.equal(evaluateRelease({ tag_name: 'release/latest', draft: false, prerelease: false }, '1.0.1'), null);
});
