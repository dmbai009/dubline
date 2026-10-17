const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UpdatePreferences } = require('../src/electron-update-preferences');

test('experimental updates require explicit opt-in, persist per local profile and survive a failed save', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-update-preferences-'));
  try {
    const first = new UpdatePreferences(path.join(folder, 'profile-a'));
    const second = new UpdatePreferences(path.join(folder, 'profile-b'));
    assert.equal(first.experimental, false);
    first.set(true);
    assert.equal(new UpdatePreferences(path.join(folder, 'profile-a')).experimental, true);
    assert.equal(second.experimental, false);
    assert.throws(() => first.set('true'), /Invalid/);
    fs.mkdirSync(first.file + '.new');
    assert.throws(() => first.set(false));
    assert.equal(first.experimental, true);
    assert.equal(new UpdatePreferences(path.join(folder, 'profile-a')).experimental, true);
    fs.rmdirSync(first.file + '.new');
    first.set(false);
    assert.equal(new UpdatePreferences(path.join(folder, 'profile-a')).experimental, false);
    for (const content of ['{broken', 'null', '{}', '{"schemaVersion":2,"experimental":true}', '{"schemaVersion":1,"experimental":"true"}', ' '.repeat(1025)]) {
      fs.writeFileSync(first.file, content);
      assert.equal(new UpdatePreferences(path.join(folder, 'profile-a')).experimental, false);
    }
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('beta builds opt in by default while preserving an explicit opt-out across beta and stable upgrades', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-beta-default-'));
  try {
    const beta = new UpdatePreferences(folder, '1.4.0-beta.1');
    assert.equal(beta.experimental, true);
    beta.set(false);
    assert.equal(new UpdatePreferences(folder, '1.4.0-beta.2').experimental, false);
    assert.equal(new UpdatePreferences(folder, '1.4.0').experimental, false);
    beta.set(true);
    assert.equal(new UpdatePreferences(folder, '1.4.0').experimental, true);
    fs.writeFileSync(beta.file, 'broken');
    assert.equal(new UpdatePreferences(folder, '1.4.0-beta.2').experimental, true);
    assert.equal(new UpdatePreferences(folder, '1.4.0').experimental, false);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
