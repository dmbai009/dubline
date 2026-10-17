const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { NsisUpdater } = require('electron-updater');
const { HttpError } = require('builder-util-runtime');
const { InstalledUpdater } = require('../src/electron-installed-update');

test('real electron-updater GitHub provider switches beta/latest and falls back to stable metadata on graduation', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-github-channel-'));
  let stable = '1.3.9', published = ['1.4.0-beta.2', stable];
  const requests = [], downloads = [];
  const metadata = version => 'version: ' + version + '\nfiles:\n  - url: Dubline-' + version + '-Setup.exe\n    sha512: YQ==\n    size: 1\n';
  try {
    const updater = new NsisUpdater(null, { version: '1.4.0-beta.1', isPackaged: true, userDataPath: profile, whenReady: async () => {} });
    updater.logger = null; updater._testOnlyOptions = { platform: 'win32' };
    updater.httpExecutor = { request: async options => {
      const url = new URL(options.path, options.protocol + '//' + options.hostname); requests.push(url.pathname);
      if (url.pathname.endsWith('.atom')) return '<feed xmlns="http://www.w3.org/2005/Atom">' + published.map(version => '<entry><title>' + version + '</title><link href="https://github.com/dmbai009/dubline/releases/tag/v' + version + '"/><content>Release notes</content></entry>').join('') + '</feed>';
      if (url.pathname.endsWith('/latest')) return JSON.stringify({ tag_name: 'v' + stable });
      const target = /\/download\/v([^/]+)\/(beta|latest)\.yml$/.exec(url.pathname);
      if (!target || target[1].includes('-beta.') !== (target[2] === 'beta')) throw new HttpError(404, 'Not found');
      return metadata(target[1]);
    } };
    updater.setFeedURL({ provider: 'github', owner: 'dmbai009', repo: 'dubline' });
    updater.downloadUpdate = async () => { const version = updater.updateInfoAndProvider.info.version; downloads.push(version); updater.emit('update-downloaded', { version }); };
    const adapter = new InstalledUpdater({ updater, currentVersion: '1.4.0-beta.1', busy: async () => false, shutdown: async () => {} });
    await adapter.check(); assert.equal(adapter.getStatus().state, 'current'); assert.deepEqual(downloads, []);
    assert.ok(requests.includes('/dmbai009/dubline/releases/download/v1.3.9/latest.yml'));
    await adapter.setExperimental(true); await adapter.check();
    assert.equal(adapter.getStatus().state, 'downloaded'); assert.deepEqual(downloads, ['1.4.0-beta.2']);
    assert.ok(requests.includes('/dmbai009/dubline/releases/download/v1.4.0-beta.2/beta.yml'));
    await adapter.setExperimental(false); await adapter.check();
    assert.equal(adapter.getStatus().state, 'current'); assert.equal(updater.allowDowngrade, false);
    stable = '1.4.0'; published = [stable, '1.4.0-beta.2'];
    await adapter.setExperimental(true); await adapter.check();
    assert.equal(adapter.getStatus().state, 'downloaded'); assert.deepEqual(downloads, ['1.4.0-beta.2', '1.4.0']);
    assert.ok(requests.includes('/dmbai009/dubline/releases/download/v1.4.0/beta.yml'));
    assert.ok(requests.includes('/dmbai009/dubline/releases/download/v1.4.0/latest.yml'));
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});
