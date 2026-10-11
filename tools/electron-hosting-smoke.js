// Real Electron main/preload/renderer; only external tool detection and the
// cloudflared child are mocked. This does not prove external service reachability.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { launch } = require('./packaged-test-driver');
const { waitUntil, waitFor, buildFixturePack, launchBrowser, openPlayer } = require('../e2e/helpers');
const root = path.join(__dirname, '..');
async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-hosting-native-'));
  let runtime, browser, guests;
  const mocks = `
    const hostingRequire = globalThis.__dublineTestRequire;
    const cp = hostingRequire('node:child_process'), originalSpawn = cp.spawn;
    const files = hostingRequire('node:fs'), exists = files.existsSync;
    files.existsSync = file => String(file).endsWith('cloudflared.exe') || exists(file);
    globalThis.__hostingChildren = [];
    cp.spawn = function(file, args, options) {
      if (!String(file).endsWith('cloudflared.exe')) return originalSpawn(file, args, options);
      const child = new (hostingRequire('node:events').EventEmitter)();
      child.stdout = new (hostingRequire('node:events').EventEmitter)(); child.stderr = new (hostingRequire('node:events').EventEmitter)();
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
      __hostingChildren.push(child);
      setTimeout(() => child.stderr.emit('data', 'https://native-' + __hostingChildren.length + '.trycloudflare.com'), 40);
      return child;
    };
    // Main owns tool detection; mock only its OS/process input boundaries.
    hostingRequire('node:os').networkInterfaces = () => ({ 'Radmin VPN': [{ family: 'IPv4', internal: false, address: '26.10.20.30' }] });
    const originalExecFile = cp.execFile;
    cp.execFile = function(file, args, options, callback) {
      if (file === 'tasklist.exe' || file === 'ps') { setImmediate(() => callback(null, 'porthole.exe')); return { kill() {} }; }
      if (file === 'reg.exe') { setImmediate(() => callback(new Error('No test Steam registry'))); return { kill() {} }; }
      return originalExecFile(file, args, options, callback);
    };`;
  try {
    runtime = await launch(require('electron'), profile, mocks, { appPath: root });
    await waitUntil(async () => { try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${runtime.browserPort}`, defaultViewport: null }); return true; } catch { return false; } });
    let launcher, page;
    await waitUntil(async () => { launcher = (await browser.pages()).find(item => item.url().includes('electron-launcher.html')); return !!launcher; });
    await launcher.$eval('[data-mode=porthole]', button => button.click()); await launcher.$eval('#startHost', button => button.click());
    await waitUntil(async () => { page = (await browser.pages()).find(item => /^http:\/\/127\.0\.0\.1:/.test(item.url())); return !!page; });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await waitFor(page, () => desktopInviteState?.mode === 'porthole');
    assert.equal(await page.evaluate(() => desktopConnection('vpn').publicUrl), `http://26.10.20.30:${new URL(page.url()).port}`, 'diagnostic boundaries must be mocked before running the UI matrix');
    assert.equal(await runtime.inspector.evaluate('__hostingChildren.length'), 0, 'Porthole launch never automatically enables Cloudflare');
    await waitFor(page, () => socket.connected && session && nickModal.style.display === 'flex');
    await page.type('#modalNickInput', 'Native host'); await page.click('#nickForm button[type=submit]'); await waitFor(page, () => amHost());
    await page.click('#helpModal [data-i18n="help.ok"]');
    await waitFor(page, () => document.getElementById('p2pConsentDialog').open);
    await page.click('#p2pConsentDecline');
    await (await page.$('#zipInput')).uploadFile(buildFixturePack());
    await waitFor(page, () => session?.loaded && session.lines.length === 4, 30000);
    const initial = await page.evaluate(() => ({ port: desktopInviteState.port, pin: desktopInviteState.pin, scene: session.activeSessionId }));
    assert.equal((await fetch(`http://127.0.0.1:${initial.port}/api/server-packs`)).status, 403, 'alternate addresses cannot bypass PIN');
    guests = await launchBrowser(initial.port);
    const guest = await openPlayer(guests, `http://localhost:${initial.port}/?room=main`, 'Native guest');
    await waitFor(guest, () => passwordModal.style.display === 'flex'); await guest.type('#passwordInput', initial.pin); await guest.click('#passwordModal button[type=submit]'); await waitFor(guest, () => session?.loaded);
    await page.evaluate(async () => { await dublineDesktop.setCloudflareEnabled(true); await dublineDesktop.setCloudflareEnabled(true); });
    await waitFor(page, () => desktopConnection('cloudflare').state === 'ready');
    for (const mode of ['vpn', 'porthole', 'vpn']) {
      const status = await page.evaluate(mode => dublineDesktop.setHostingMode(mode), mode);
      assert.equal(status.cloudflare.state, 'ready'); assert.equal(status.cloudflare.publicUrl, 'https://native-1.trycloudflare.com');
      assert.equal(status.port, initial.port); assert.equal(status.pin, initial.pin); assert.equal(status.room, 'main');
      assert.equal(await runtime.inspector.evaluate('__hostingChildren.length'), 1);
      assert.equal(await guest.evaluate(() => socket.connected && session.activeSessionId), initial.scene);
    }
    const resize = (width, height, scale) => runtime.inspector.evaluate(`require('electron').BrowserWindow.getAllWindows().find(window => /^http:/.test(window.webContents.getURL())).setContentSize(${width}, ${height}); require('electron').BrowserWindow.getAllWindows().find(window => /^http:/.test(window.webContents.getURL())).webContents.setZoomFactor(${scale}); true`);
    for (const [width, height] of [[1024, 768], [1280, 720], [1920, 1080]]) for (const scale of [1, 1.25, 1.5]) {
      await resize(width, height, scale);
      await waitFor(page, (width, height, scale) => Math.abs(innerWidth - width / scale) <= 1 && Math.abs(innerHeight - height / scale) <= 1, 10000, width, height, scale);
      for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
        await page.evaluate(async (theme, language) => { closeDesktopInvite(false); document.documentElement.dataset.theme = theme; await i18n.setLanguage(language); }, theme, language);
        // Native content-size and zoom changes settle asynchronously.
        // Hidden native windows can suspend rAF. Observe settled geometry
        // directly instead of waiting on a renderer animation callback.
        let previous = '';
        await waitUntil(async () => {
          const geometry = await page.evaluate(() => JSON.stringify({ width: innerWidth, height: innerHeight, header: document.querySelector('header').getBoundingClientRect().height }));
          const settled = geometry === previous; previous = geometry; return settled;
        });
        const before = await page.$eval('header', node => ({ height: node.getBoundingClientRect().height, room: document.querySelector('.room-badge').getBoundingClientRect().x }));
        await page.click('#desktopInviteToggle');
        const result = await page.evaluate(() => {
          const header = document.querySelector('header').getBoundingClientRect(), popover = document.getElementById('desktopInvitePopover'), rect = popover.getBoundingClientRect();
          return { height: header.height, room: document.querySelector('.room-badge').getBoundingClientRect().x, visible: !popover.hidden, inside: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, unobstructed: popover.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + 60)), pin: document.getElementById('desktopPinCode').textContent };
        });
        assert.equal(result.height, before.height, JSON.stringify({ width, scale, theme, language, before, result })); assert.equal(result.room, before.room); assert.equal(result.inside, true, `${width}/${scale}/${theme}/${language}`); assert.equal(result.unobstructed, true); assert.equal(result.visible, true); assert.equal(result.pin, '••••');
        await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => document.activeElement.id), 'desktopInviteToggle');
        if (theme === 'sunset' && language === 'uk') console.log(`Native invitation ${width}×${height} at ${scale * 100}%: 6 themes and 3 languages PASS`);
      }
    }
    await page.evaluate(() => selectDesktopInviteMode('cloudflare')); await page.click('#desktopInviteToggle');
    await page.click('#desktopCloudflareToggle'); await waitFor(page, () => desktopConnection('cloudflare').state === 'idle');
    assert.equal(await page.$eval('#desktopCopyBtn', node => node.disabled), true); assert.equal(await page.$eval('#desktopInviteUrl', node => node.value), '');
    assert.equal(await guest.evaluate(() => socket.connected && session.activeSessionId), initial.scene);
    await page.click('[data-invite-mode=vpn]'); assert.match(await page.$eval('#desktopInviteUrl', node => node.value), /^http:\/\/26\.10\.20\.30:/);
    await page.click('[data-invite-mode=cloudflare]'); await page.click('#desktopCloudflareToggle'); await waitFor(page, () => desktopConnection('cloudflare').publicUrl === 'https://native-2.trycloudflare.com');
    await resize(1280, 720, 1); await waitFor(page, () => innerWidth === 1280);
    await page.evaluate(async () => { document.documentElement.dataset.theme = 'light'; await i18n.setLanguage('ru'); closeDesktopInvite(false); toggleDesktopInvitePanel(); });
    const screens = path.join(root, 'build', 'ui-cleanup-qa', 'electron'); fs.mkdirSync(screens, { recursive: true });
    await page.screenshot({ path: path.join(screens, 'stage2-invitation-light.png') });
    await page.click('#desktopPinEye'); assert.equal(await page.$eval('#desktopPinCode', node => node.textContent), initial.pin);
    await page.click('#desktopConnectionSettings'); assert.equal(await page.$eval('#desktopPinCode', node => node.textContent), '••••'); assert.equal(await page.$eval('#desktopInvitePopover', node => node.hidden), true);
    assert.deepEqual(errors, []);
    console.log('Native hosting IPC, independent mocked tunnel, PIN boundary and popover themes/locales/windows/100–150%: PASS. External network services were mocked.');
  } finally {
    await guests?.close(); browser?.disconnect();
    if (runtime) { await runtime.inspector.evaluate("require('electron').app.quit()").catch(() => {}); runtime.inspector.close(); await waitUntil(() => runtime.child.exitCode !== null, 15000).catch(() => runtime.child.kill()); }
    if (!runtime || runtime.child.exitCode !== null) fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
