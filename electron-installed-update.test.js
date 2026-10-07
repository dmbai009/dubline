const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { InstalledUpdater } = require('./electron-installed-update');
function fixture(version = '1.4.1') {
  const updater = new EventEmitter(); let downloads = 0, installs = 0, flushed = 0, busy = false;
  updater.checkForUpdates = async () => { updater.emit('checking-for-update'); updater.emit('update-available', { version }); };
  updater.downloadUpdate = async () => { downloads++; updater.emit('download-progress', { percent: 37, transferred: 37, total: 100, bytesPerSecond: 10 }); updater.emit('update-downloaded', { version }); };
  updater.quitAndInstall = () => { assert.equal(flushed, 1); installs++; };
  const adapter = new InstalledUpdater({ updater, currentVersion: '1.4.0', busy: async () => busy, shutdown: async () => { flushed++; } });
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
test('Setup rejects prerelease/downgrade and never declares download success without verification event', async () => {
  for (const version of ['1.5.0-beta.1', '1.3.9', 'x', '1.4.0']) {
    const f = fixture(version); await f.adapter.check(); assert.equal(f.adapter.getStatus().state, 'error'); assert.equal(f.counts().downloads, 0);
  }
  const f = fixture(); f.updater.downloadUpdate = async () => {};
  await f.adapter.check(); assert.equal(f.adapter.getStatus().state, 'downloading');
  assert.equal((await f.adapter.installOrRestart()).ok, false);
  f.updater.emit('error', Error('hash mismatch')); assert.equal(f.adapter.getStatus().state, 'error');
});
