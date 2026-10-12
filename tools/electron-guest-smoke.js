// Real packaged guest windows: preferences survive a new host origin without host capabilities.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { startServer, wait, launchBrowser, openPlayer, loadFixture, waitFor, claimAndSelect, recordTake } = require('../e2e/helpers');
const root = path.join(__dirname, '..');
const executable = process.env.DUBLINE_SMOKE_EXE ? path.resolve(root, process.env.DUBLINE_SMOKE_EXE) : path.join(root, 'dist', process.argv.includes('--portable') ? 'portable' : 'win-unpacked', 'Dubline.exe');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function guest(url, userData, expected, next, { media = false } = {}) {
  const port = await freePort();
  const child = spawn(executable, [`--dubline-join=${encodeURIComponent(url)}`, `--remote-debugging-port=${port}`, '--disable-gpu',
    ...(media ? ['--host-resolver-rules=MAP 26.0.0.1 127.0.0.1', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : [])], {
    cwd: root, env: { ...process.env, DUBLINE_USER_DATA_DIR: userData }, windowsHide: true, stdio: 'ignore'
  });
  let browser;
  try {
    for (let n = 0; n < 120 && !browser; n++) {
      try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }); } catch { await wait(250); }
    }
    assert.ok(browser, 'Guest debugging endpoint did not start');
    let page;
    for (let n = 0; n < 80 && !page; n++) {
      page = (await browser.pages()).find(p => p.url().startsWith(new URL(url).origin));
      if (!page) await wait(250);
    }
    assert.ok(page, 'Guest window did not open');
    page.errors = []; page.on('pageerror', error => page.errors.push(error.message));
    await page.waitForFunction(() => typeof DublineI18n !== 'undefined');
    const state = await page.evaluate(() => ({ language: DublineI18n.getLanguage(),
      preferences: Object.keys(window.dublinePreferences || {}).sort(), hostBridge: !!window.dublineDesktop,
      requireType: typeof require, desktopUi: document.body.classList.contains('desktop-mode') }));
    assert.deepEqual(state, { language: expected, preferences: ['language', 'setLanguage'], hostBridge: false, requireType: 'undefined', desktopUi: false });
    if (next) {
      await page.evaluate(async code => { await DublineI18n.setLanguage(code); await dublinePreferences.setLanguage(code); }, next);
      assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'language.json'), 'utf8')), next);
    }
    if (media) {
      await waitFor(page, () => passwordModal.style.display === 'flex');
      assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/media-manifest'))), false, 'no media manifest before PIN');
      await page.type('#passwordNickInput', 'Native guest'); await page.type('#passwordInput', 'ABCD'); await page.click('#passwordModal button[type=submit]');
      await waitFor(page, () => session?.loaded && myName === 'Native guest' && hasSceneMediaAccess());
      await page.evaluate(() => closeHelpModal());
      await waitFor(page, () => p2pConsentDialog.open); await page.click('#p2pConsentDecline');
      await waitFor(page, () => localMedia?.videoBlob && !mediaDownload && video.readyState >= 2);
      assert.deepEqual(await page.evaluate(() => ({ host: location.hostname, secure: isSecureContext, digest: typeof crypto.subtle?.digest,
        microphone: typeof navigator.mediaDevices?.getUserMedia, p2p: p2pAllowed() })),
        { host: '26.0.0.1', secure: true, digest: 'function', microphone: 'function', p2p: false });
      assert.equal(await page.evaluate(async () => await sha256Hex(localMedia.videoBlob) === session.videoHash), true);
      await claimAndSelect(page, 1); await recordTake(page, 1);
      assert.equal(await page.evaluate(() => session.lines.find(line => line.id === 1).recordedBy), 'Native guest');
      assert.deepEqual(page.errors, []);
      console.log('Native private-HTTP guest: PIN/nickname admission, production trusted-origin policy, verified HTTP media and real fake-device recording PASS; external VPN routing was simulated.');
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (let n = 0; n < 40 && child.exitCode === null; n++) await wait(100);
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 5000); });
    }
  }
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-guest-smoke-'));
  let server, secured, hostBrowser;
  try {
    assert.ok(fs.existsSync(executable), 'Build with npm run dist first');
    fs.writeFileSync(path.join(userData, 'language.json'), JSON.stringify('uk'));
    server = await startServer();
    await guest(server.url('language', '127.0.0.1'), userData, 'uk', 'ru');
    await guest(server.url('language', 'localhost'), userData, 'ru');
    secured = await startServer({ DUBLINE_DESKTOP_ROOM: 'main', DUBLINE_DESKTOP_HOST_TOKEN: 'guest-media-host', DUBLINE_ROOM_PIN: 'ABCD' });
    hostBrowser = await launchBrowser(secured.port);
    const host = await openPlayer(hostBrowser, secured.url('main') + '&desktopHost=guest-media-host', 'Media host'); await loadFixture(host);
    await guest(secured.url('main', '26.0.0.1'), userData, 'ru', null, { media: true });
    console.log('Packaged guest smoke passed: language persistence across origins; language-only bridge; no host UI or Node access.');
  } finally {
    await hostBrowser?.close(); await secured?.cleanup();
    if (server) await server.cleanup();
    assert.equal(path.dirname(path.resolve(userData)), path.resolve(os.tmpdir())); assert.ok(path.basename(userData).startsWith('dubline-guest-smoke-'));
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
