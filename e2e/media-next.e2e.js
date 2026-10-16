const { describe, test, before, after } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor } = require('./helpers');
const { mediaProxy } = require('./media-transfer-proxy');
describe('readable media failure and recovery states', { skip: skipReason, timeout: 90000 }, () => {
  let server, browser, host;
  before(async () => { require('node:fs').mkdirSync(path.resolve('audit/live-presets'), { recursive: true }); server = await startServer(); browser = await launchBrowser(server.port, { secureOrigin: false }); host = await openPlayer(browser, server.url('media-next'), 'Host'); await loadFixture(host); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('real access failure shows safe details and an explicit retry restores the same scene', async () => {
    let blocked = true, requests = 0; const proxy = await mediaProxy(server.port, { rule: request => { if (request.url.startsWith('/api/media-manifest') && new URL(request.url, 'http://host').searchParams.get('url')?.endsWith('dub_video.mp4')) { requests++; if (blocked) return { status: 403 }; } } });
    const guest = await openPlayer(browser, proxy.url('media-next'), 'Media guest');
    try {
      await waitFor(guest, () => DublineMediaTransfer.stats().status === 'failed' && mediaReadinessOverlay.dataset.phase === 'access'); const id = await guest.evaluate(() => session.activeSessionId); assert.equal(requests, 1); assert.equal(await guest.$eval('#mediaReadinessMessage', node => node.textContent), await guest.evaluate(() => t('media.transfer.error.403'))); assert.equal(await guest.$eval('#mediaReadinessOverlay', node => node.hidden), false);
      await guest.click('#mediaReadinessDetails summary'); const details = await guest.$eval('#mediaReadinessDetails p', node => node.textContent); assert.match(details, /HTTP 403/); assert.doesNotMatch(details, /token|pin=|password|uploads\/|C:\\|D:\\/i);
      await guest.setViewport({ width: 640, height: 850 }); await guest.evaluate(async () => { await DublineI18n.setLanguage('uk'); document.documentElement.dataset.theme = 'light'; document.body.style.zoom = '150%'; }); await guest.screenshot({ path: path.resolve('audit/live-presets/media-access-light-uk-150.png') });
      blocked = false; await guest.evaluate(() => { document.body.style.zoom = ''; }); await guest.setViewport({ width: 1600, height: 900 }); await guest.click('#mediaReadinessRetry'); await waitFor(guest, () => DublineMediaTransfer.stats().status === 'ready' && video.readyState >= 3); assert.equal(await guest.evaluate(() => session.activeSessionId), id); assert.equal(requests, 2); assert.deepEqual(guest.errors, []);
    } finally { await guest.browserContext().close(); await proxy.close(); }
  });
  test('manual cancellation keeps the scene and resuming uses the existing download mechanism', async () => {
    const guest = await openPlayer(browser, server.url('media-next', 'dubline.test'), 'Cancel guest', { beforeLoad: page => page.evaluateOnNewDocument(() => { const original = fetch; window.fetch = async (url, options) => { if (options?.headers?.Range && !window.releaseMediaNext) await new Promise(resolve => { window.releaseMediaNext = resolve; options.signal?.addEventListener('abort', resolve, { once: true }); }); return original(url, options); }; }) });
    try { await waitFor(guest, () => !!mediaDownload && !!window.releaseMediaNext); const id = await guest.evaluate(() => session.activeSessionId); await guest.click('#mediaReadinessCancel'); await waitFor(guest, () => mediaReadinessOverlay.dataset.phase === 'cancelled'); assert.equal(await guest.evaluate(() => session.activeSessionId), id); await guest.click('#mediaReadinessRetry'); await waitFor(guest, () => DublineMediaTransfer.stats().status === 'ready' && video.readyState >= 3); assert.deepEqual(guest.errors, []); }
    finally { await guest.browserContext().close(); }
  });
});
