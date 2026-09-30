// Smoke-test the packaged Electron app through its Chromium debugging endpoint.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const puppeteer = require('puppeteer-core');

const root = path.join(__dirname, '..');
const executable = path.join(root, 'dist', 'win-unpacked', 'Dubline.exe');
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
  const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, '--disable-gpu'], {
    cwd: root,
    env: { ...process.env, DUBLINE_USER_DATA_DIR: userData },
    stdio: 'ignore',
    windowsHide: true
  });
  let browser;
  try {
    for (let attempt = 0; attempt < 80 && !(await endpointReady(debugPort)); attempt++) await wait(250);
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
    assert.equal(await launcher.$eval('#launcherVersion', node => node.textContent), 'Dubline v1.1.0');
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
    // Files are served only to the host and PIN guests: the native window passes, a stranger does not
    await host.waitForFunction(() => typeof session !== 'undefined' && !!session);
    assert.equal(await host.evaluate(async () => (await fetch('/api/server-packs')).status), 200, 'the host cannot reach its pack library');
    assert.equal((await fetch(`http://127.0.0.1:${result.port}/api/server-packs`)).status, 403, 'a stranger can list the pack library');
    if (hostingMode === 'cloudflare') {
      await host.waitForFunction(() => document.getElementById('desktopInviteUrl')?.value.startsWith('https://'));
      result.inviteUrl = await host.$eval('#desktopInviteUrl', input => input.value);
      assert.match(result.inviteUrl, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    }
    process.stdout.write(`Packaged Electron ${hostingMode} smoke test passed on port ${result.port}.\n`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt++) await wait(200);
    if (child.exitCode === null) child.kill();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
