const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, isNewerVersion, evaluateRelease, selectRelease } = require('../src/electron-update');
const { isAppVersion, nextTestVersion } = require('../src/update-version');

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

test('numbered betas compare numerically and graduate to stable without allowing downgrades', () => {
  const sequence = ['1.3.9', '1.4.0-beta.1', '1.4.0-beta.2', '1.4.0-beta.10', '1.4.0', '1.4.1-beta.1', '1.4.1'];
  for (let a = 0; a < sequence.length; a++) for (let b = 0; b < sequence.length; b++) {
    assert.equal(isNewerVersion(sequence[a], sequence[b]), a > b, sequence[a] + ' vs ' + sequence[b]);
  }
  for (const value of ['1.4.0beta1', '1.4.0-beta', '1.4.0-beta.01', '1.4.0-alpha.1', '01.4.0', '1.4.0-beta.9007199254740992', '../1.4.0', 'v1.4.0']) assert.equal(isAppVersion(value), false, value);
  assert.equal(isAppVersion('1.4.0-beta.10'), true);
  assert.equal(nextTestVersion('1.4.0-beta.1'), '1.4.0-beta.2');
  assert.equal(nextTestVersion('1.4.0'), '1.4.1');
  assert.equal(isNewerVersion('1.4.0+build.2', '1.4.0+build.1'), false);
});

test('experimental selection ignores drafts, other channels and publish order; stable policy excludes even a mislabeled beta', () => {
  const release = (tag, prerelease = false, draft = false) => ({ tag_name: 'v' + tag, prerelease, draft });
  const releases = [release('1.4.0-beta.2', true), release('1.4.0-beta.10', true),
    release('1.4.0-beta.11', true, true), release('1.5.0-alpha.1', true), release('1.5.0', true), release('1.3.9')];
  assert.equal(selectRelease(releases, '1.3.8', true).tag_name, 'v1.4.0-beta.10');
  assert.equal(selectRelease(releases, '1.3.8').tag_name, 'v1.3.9');
  assert.equal(selectRelease(releases, '1.4.0', true), null);
  assert.equal(evaluateRelease(release('1.4.0-beta.10'), '1.3.8'), null);
  assert.equal(evaluateRelease(release('1.4.0-beta.10'), '1.3.8', true).version, '1.4.0-beta.10');
  assert.equal(selectRelease([...releases, release('1.4.0')], '1.4.0-beta.10', true).tag_name, 'v1.4.0');
  assert.equal(selectRelease([...releases, release('1.4.0')], '1.4.0-beta.10').tag_name, 'v1.4.0');
  assert.throws(() => selectRelease({}), /release list/);
});
