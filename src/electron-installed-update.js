const { EventEmitter } = require('node:events');
const { isNewerVersion } = require('./electron-update');

class InstalledUpdater extends EventEmitter {
  constructor({ currentVersion, updater, busy, shutdown }) {
    super(); this.currentVersion = currentVersion; this.updater = updater;
    this.busy = busy; this.shutdown = shutdown; this.job = null; this.installing = false;
    this.status = { state: 'idle', currentVersion, version: '', url: '', progress: null };
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false; updater.allowDowngrade = false;
    updater.on('checking-for-update', () => this.set({ state: 'checking', error: '' }));
    updater.on('update-not-available', () => this.set({ state: 'current', version: '', progress: null }));
    updater.on('update-available', info => {
      if (!/^\d+\.\d+\.\d+$/.test(info.version) || !isNewerVersion(info.version, currentVersion)) {
        this.set({ state: 'error', error: 'Update metadata does not describe a newer stable release.' }); return;
      }
      this.set({ state: 'available', version: info.version,
        url: `https://github.com/dmbai009/dubline/releases/tag/v${info.version}`, progress: null });
    });
    updater.on('download-progress', data => {
      if (this.status.state !== 'downloading') return;
      this.set({ progress: { percent: Math.max(0, Math.min(100, Number(data.percent) || 0)),
        transferred: Math.max(0, Number(data.transferred) || 0), total: Math.max(0, Number(data.total) || 0),
        bytesPerSecond: Math.max(0, Number(data.bytesPerSecond) || 0) } });
    });
    updater.on('update-downloaded', info => {
      if (info.version === this.status.version && this.status.state === 'downloading') this.set({ state: 'downloaded', progress: null });
    });
    // Log/details belong to the updater; normalized UI errors do not expose local paths.
    updater.on('error', () => this.set({ state: 'error', error: 'Update failed. Retry or download the official release manually.', progress: null }));
  }
  set(value) { this.status = { ...this.status, ...value }; this.emit('status', this.getStatus()); }
  getStatus() { return { ...this.status }; }
  check() {
    if (this.job) return this.job;
    if (['downloaded', 'installing'].includes(this.status.state)) return Promise.resolve(this.getStatus());
    this.job = (async () => {
      try {
        this.set({ state: 'checking', error: '' });
        await this.updater.checkForUpdates();
        if (this.status.state === 'available') {
          this.set({ state: 'downloading' });
          await this.updater.downloadUpdate();
          // Only update-downloaded can declare success (hash/signature validation included).
        }
      } catch (_) { this.set({ state: 'error', error: 'Update failed. Retry or download the official release manually.', progress: null }); }
      return this.getStatus();
    })().finally(() => { this.job = null; });
    return this.job;
  }
  async installOrRestart() {
    if (this.installing || this.status.state !== 'downloaded') return { ok: false, code: 'not-ready' };
    this.installing = true;
    try {
      if (await this.busy()) return { ok: false, code: 'busy' };
      this.set({ state: 'installing' });
      await this.shutdown();
      this.updater.quitAndInstall(false, true);
      return { ok: true };
    } catch (_) {
      this.set({ state: 'error', error: 'The update could not be installed. Download the official release manually.' });
      return { ok: false, code: 'install-failed' };
    } finally { this.installing = false; }
  }
}
module.exports = { InstalledUpdater };
