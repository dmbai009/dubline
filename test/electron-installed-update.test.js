const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { InstalledUpdater } = require('../src/electron-installed-update');
function fixture(version = '1.4.1', options = {}) {
  const updater = new EventEmitter(); let downloads = 0, installs = 0, flushed = 0, busy = false;
  updater.checkForUpdates = async () => { updater.emit('checking-for-update'); updater.emit('update-available', { version }); };
  updater.downloadUpdate = async () => { downloads++; updater.emit('download-progress', { percent: 37, transferred: 37, total: 100, bytesPerSecond: 10 }); updater.emit('update-downloaded', { version }); };
  updater.quitAndInstall = () => { assert.equal(flushed, 1); installs++; };
  // The real electron-updater channel setter also turns allowDowngrade on.
  Object.defineProperty(updater, 'channel', { get() { return this._channel; }, set(value) { this._channel = value; this.allowDowngrade = true; } });
  const adapter = new InstalledUpdater({ updater, currentVersion: '1.4.0', busy: async () => busy, shutdown: async () => { flushed++; }, ...options });
  return { updater, adapter, busy(value) { busy = value; }, counts: () => ({ downloads, installs, flushed }) };
}
test('Setup downloads a stable update, reports authoritative progress, waits for explicit idle restart and flushes first', async () => {
  const f = fixture(), states = []; f.adapter.on('status', status => states.push(status));
  assert.equal(f.updater.autoDownload, false); assert.equal(f.updater.autoInstallOnAppQuit, false);
  const first = f.adapter.check(), duplicate = f.adapter.check(); assert.equal(first, duplicate); await first;
  assert.equal(f.adapter.getStatus().state, 'downloaded'); assert.equal(f.counts().installs, 0);
  assert.equal(states.find(state => state.progress)?.progress.percent, 37);
  f.busy(true); assert.equal((await f.adapter.installOrRestart()).code, 'busy');
  assert.equal(f.adapter.getStatus().state, 'downloaded'); assert.equal(f.counts().flushed, 0);
  f.busy(false); assert.equal((await f.adapter.installOrRestart()).ok, true);
  assert.deepEqual(f.counts(), { downloads: 1, installs: 1, flushed: 1 });
});

test('Setup experimental opt-in downloads betas, disabling it discards the offer and does not downgrade', async () => {
  const f = fixture('1.4.0-beta.10', { currentVersion: '1.4.0-beta.2' });
  assert.equal(f.updater.channel, 'latest'); assert.equal(f.updater.allowPrerelease, false);
  await f.adapter.check(); assert.equal(f.counts().downloads, 0);
  assert.equal((await f.adapter.setExperimental(true)).ok, true);
  assert.equal(f.updater.channel, 'beta'); assert.equal(f.updater.allowPrerelease, true); assert.equal(f.updater.allowDowngrade, false);
  await f.adapter.check(); assert.equal(f.adapter.getStatus().state, 'downloaded');
  await f.adapter.setExperimental(false);
  assert.equal(f.updater.channel, 'latest'); assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.adapter.getStatus().version, ''); assert.equal((await f.adapter.installOrRestart()).ok, false);
  assert.equal(f.counts().installs, 0);
  for (const experimental of [false, true]) {
    const stable = fixture('1.4.0', { currentVersion: '1.4.0-beta.10', experimental });
    await stable.adapter.check(); assert.equal(stable.adapter.getStatus().state, 'downloaded');
    const old = fixture('1.3.9', { currentVersion: '1.4.0-beta.10', experimental });
    await old.adapter.check(); assert.equal(old.counts().downloads, 0);
  }
});

test('Setup cannot switch channels during a download; late verification events cannot resurrect a discarded offer', async () => {
  const f = fixture('1.5.0-beta.1', { experimental: true });
  let releaseDownload;
  f.updater.downloadUpdate = () => new Promise(resolve => { releaseDownload = resolve; });
  const download = f.adapter.check();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.adapter.getStatus().state, 'downloading');
  assert.equal((await f.adapter.setExperimental(false)).code, 'busy');
  assert.equal(f.updater.allowPrerelease, true);
  releaseDownload(); await download;
  await f.adapter.setExperimental(false);
  f.updater.emit('update-downloaded', { version: '1.5.0-beta.1' });
  assert.equal(f.adapter.getStatus().state, 'idle');
});
test('Setup rejects prerelease/downgrade and never declares download success without verification event', async () => {
  for (const version of ['1.5.0-beta.1', '1.3.9', 'x', '1.4.0']) {
    const f = fixture(version); await f.adapter.check(); assert.equal(f.adapter.getStatus().state, 'error'); assert.equal(f.counts().downloads, 0);
  }
  const f = fixture(); f.updater.downloadUpdate = async () => {};
  await f.adapter.check(); assert.equal(f.adapter.getStatus().state, 'downloading');
  assert.equal((await f.adapter.installOrRestart()).ok, false);
  f.updater.emit('error', Error('hash mismatch')); assert.equal(f.adapter.getStatus().state, 'error');
});
