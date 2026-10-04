// Smoke-test the packaged Electron app through its Chromium debugging endpoint.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const puppeteer = require('puppeteer-core');
const AdmZip = require('adm-zip');
const { launchBrowser, openPlayer, buildFixturePack } = require('../e2e/helpers');

const root = path.join(__dirname, '..');
const executable = process.env.DUBLINE_SMOKE_EXE
  ? path.resolve(root, process.env.DUBLINE_SMOKE_EXE)
  : process.argv.includes('--portable')
    ? path.join(root, 'dist', 'Dubline.exe')
    : path.join(root, 'dist', 'win-unpacked', 'Dubline.exe');
if (!fs.existsSync(executable)) throw new Error('Build the app with npm run dist first.');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function endpointReady(port) {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/json/version`, response => {
      response.resume(); resolve(response.statusCode === 200);
    });
    request.once('error', () => resolve(false));
    request.setTimeout(500, () => { request.destroy(); resolve(false); });
  });
}

async function main() {
  const hostingMode = process.argv[2] === 'cloudflare' ? 'cloudflare' : 'porthole';
  const debugPort = await freePort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-electron-smoke-'));
  const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, '--disable-gpu',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], {
    cwd: root,
    env: { ...process.env, DUBLINE_USER_DATA_DIR: userData },
    stdio: 'ignore',
    windowsHide: true
  });
  let browser;
  let guestBrowser;
  let serverPort;
  let succeeded = false;
  try {
    for (let attempt = 0; attempt < 120 && !(await endpointReady(debugPort)); attempt++) await wait(250);
    assert.equal(await endpointReady(debugPort), true, 'Electron debugging endpoint did not start');
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` });
    let launcher;
    for (let attempt = 0; attempt < 40 && !launcher; attempt++) {
      launcher = (await browser.pages()).find(page => page.url().includes('electron-launcher.html'));
      if (!launcher) await wait(250);
    }
    assert.ok(launcher, 'Launcher window did not open');
    assert.equal(await launcher.$$eval('.mode', nodes => nodes.length), 3);
    await launcher.waitForFunction(() => document.getElementById('launcherVersion')?.textContent.startsWith('Dubline v'));
    assert.equal(await launcher.$eval('#launcherVersion', node => node.textContent), `Dubline v${require('../package.json').version}`);
    await launcher.$eval(`[data-mode="${hostingMode}"]`, button => button.click());
    await launcher.$eval('#startHost', button => button.click());

    let host;
    for (let attempt = 0; attempt < 80 && !host; attempt++) {
      host = (await browser.pages()).find(page => /^http:\/\/127\.0\.0\.1:\d+\//.test(page.url()));
      if (!host) await wait(250);
    }
    assert.ok(host, 'Host room did not open');
    const diagnostics = [];
    host.on('console', message => diagnostics.push(`console: ${message.text()}`));
    host.on('pageerror', error => diagnostics.push(`page: ${error.message}`));
    let desktopReady = false;
    for (let attempt = 0; attempt < 60 && !desktopReady; attempt++) {
      desktopReady = await host.evaluate(() => !!document.body?.classList.contains('desktop-mode'));
      if (!desktopReady) await wait(250);
    }
    const bridgeState = await host.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      hasDesktopBridge: !!window.dublineDesktop,
      bodyClass: document.body?.className || ''
    }));
    assert.equal(desktopReady, true, `Desktop UI did not initialize: ${JSON.stringify(bridgeState)} ${diagnostics.join(' | ')}`);
    await host.waitForFunction(() => Number(document.getElementById('desktopHostingPort')?.textContent) >= 38473);
    const result = await host.evaluate(() => ({
      port: Number(document.getElementById('desktopHostingPort').textContent),
      mode: document.querySelector('.hosting-mode.active')?.dataset.hostingMode,
      inviteUrl: document.getElementById('desktopInviteUrl').value
    }));
    assert.ok(result.port >= 38473 && result.port <= 38637, `Unexpected host port ${result.port}`);
    assert.equal(result.mode, hostingMode);
    serverPort = result.port;
    // Files are served only to the host and PIN guests: the native window passes, a stranger does not
    await host.waitForFunction(() => typeof session !== 'undefined' && !!session);
    assert.equal(await host.evaluate(async () => (await fetch('/api/server-packs')).status), 200, 'the host cannot reach its pack library');
    assert.equal((await fetch(`http://127.0.0.1:${result.port}/api/server-packs`)).status, 403, 'a stranger can list the pack library');
    if (hostingMode === 'cloudflare') {
      await host.waitForFunction(() => document.getElementById('desktopInviteUrl')?.value.startsWith('https://'), { timeout: 90000 });
      result.inviteUrl = await host.$eval('#desktopInviteUrl', input => input.value);
      assert.match(result.inviteUrl, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    }
    await host.evaluate(() => {
      modalNickInput.value = 'Smoke Host';
      handleNickSubmit(new Event('submit', { cancelable: true }));
      localStorage.setItem('dubline_help_seen', '1');
      closeHelpModal();
    });
    await host.waitForFunction(() => myName === 'Smoke Host' && amHost());
    await (await host.$('#zipInput')).uploadFile(buildFixturePack());
    await host.waitForFunction(() => session.loaded && session.lines.length === 4 && video.readyState >= 2, { timeout: 30000 });
    const pin = await host.evaluate(async () => (await window.dublineDesktop.getStatus()).pin);
    guestBrowser = await launchBrowser(result.port);
    const guestUrl = hostingMode === 'cloudflare' ? result.inviteUrl : host.url();
    const guest = await openPlayer(guestBrowser, guestUrl, 'Smoke Guest');
    await guest.waitForFunction(() => document.getElementById('passwordModal').style.display === 'flex');
    await guest.evaluate(code => {
      passwordNickInput.value = 'Smoke Guest';
      passwordInput.value = code;
      submitRoomPassword(new Event('submit', { cancelable: true }));
    }, pin);
    await guest.waitForFunction(() => session && session.loaded && session.lines.length === 4 && video.readyState >= 2, { timeout: 60000 });
    assert.equal(await guest.evaluate(() => amHost()), false, 'PIN guest gained host rights');
    process.stdout.write('PIN guest joined and loaded packaged scene media.\n');

    await host.evaluate(() => setStudioMode('edit'));
    await guest.waitForFunction(() => session.mode === 'edit');
    const created = await guest.evaluate(() => queueEditorRequest(() => ['editor_create_line', {
      character: 'Smoke role', caption: 'Packaged smoke line', start: 1, end: 2
    }]));
    assert.equal(created.ok, true);
    await host.waitForFunction(id => session.lines.some(line => line.id === id), {}, created.line.id);
    assert.equal((await guest.evaluate(id => updateEditorLine(session.lines.find(line => line.id === id), {
      caption: 'Edited packaged line', end: 2.5
    }), created.line.id)).ok, true);
    await host.waitForFunction(id => session.lines.find(line => line.id === id)?.caption === 'Edited packaged line', {}, created.line.id);
    assert.equal((await guest.evaluate(() => editorUndo())).undone, 1);
    await host.waitForFunction(id => session.lines.find(line => line.id === id)?.caption === 'Packaged smoke line', {}, created.line.id);
    await guest.evaluate(() => claimCharacter('Smoke role'));
    await guest.waitForFunction(() => session.characterClaims['Smoke role'] === 'Smoke Guest');
    await host.evaluate(() => setStudioMode('dub'));
    await guest.waitForFunction(() => session.mode === 'dub');
    await guest.evaluate(id => {
      selectLine(session.lines.find(line => line.id === id));
      handleStudioRecord(id);
    }, created.line.id);
    await host.waitForFunction(id => !!session.lines.find(line => line.id === id)?.audioUrl, { timeout: 30000 }, created.line.id);
    await host.evaluate(() => socket.emit('set_blind_mode', { enabled: true }));
    await host.waitForFunction(id => session.blindMode && !canHearLine(session.lines.find(line => line.id === id)), {}, created.line.id);
    await host.evaluate(() => revealAllTakes());
    await host.waitForFunction(id => canHearLine(session.lines.find(line => line.id === id)), {}, created.line.id);
    await guest.evaluate(() => { socket.disconnect(); socket.connect(); });
    await guest.waitForFunction(() => socket.connected && myName === 'Smoke Guest' && session.loaded);

    const archive = await host.evaluate(async () => {
      const response = await fetch('/api/export-voxalike-pack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: currentRoom, clientId })
      });
      if (!response.ok) throw new Error(await response.text());
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    });
    const zip = new AdmZip(Buffer.from(archive, 'base64'));
    const lineEntries = zip.getEntries().filter(entry => /^\d+_.+\.ini$/.test(entry.entryName));
    assert.equal(lineEntries.length, 5);
    assert.ok(lineEntries.some(entry => zip.readAsText(entry).includes('Packaged smoke line')));
    await host.evaluate(() => toggleExpandedVideo());
    assert.equal(await host.evaluate(() => document.body.classList.contains('video-expanded')), true);
    await host.evaluate(() => toggleExpandedVideo());
    assert.deepEqual(guest.errors, [], 'guest page errors');
    assert.equal(diagnostics.some(message => message.startsWith('page:')), false, diagnostics.join(' | '));
    succeeded = true;
    process.stdout.write(`Packaged Electron ${hostingMode} smoke passed: import, shared edit/Undo, Dub, recording, Blind Mode, reconnect and ZIP export (${path.basename(path.dirname(executable))}/${path.basename(executable)}).\n`);
  } finally {
    if (guestBrowser) await guestBrowser.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt++) await wait(200);
    if (child.exitCode === null) child.kill();
    for (let attempt = 0; attempt < 40 && await endpointReady(debugPort); attempt++) await wait(250);
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  if (succeeded && serverPort) {
    await assert.rejects(fetch(`http://127.0.0.1:${serverPort}/api/server-packs`), 'packaged server was left running after closing the app');
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
