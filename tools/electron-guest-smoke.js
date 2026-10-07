// Real packaged guest windows: preferences survive a new host origin without host capabilities.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { startServer, wait } = require('../e2e/helpers');
const root = path.join(__dirname, '..');
const executable = process.env.DUBLINE_SMOKE_EXE ? path.resolve(root, process.env.DUBLINE_SMOKE_EXE) : path.join(root, 'dist', process.argv.includes('--portable') ? 'portable' : 'win-unpacked', 'Dubline.exe');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function guest(url, userData, expected, next) {
  const port = await freePort();
  const child = spawn(executable, [`--dubline-join=${encodeURIComponent(url)}`, `--remote-debugging-port=${port}`, '--disable-gpu'], {
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
    await page.waitForFunction(() => typeof DublineI18n !== 'undefined');
    const state = await page.evaluate(() => ({ language: DublineI18n.getLanguage(),
      preferences: Object.keys(window.dublinePreferences || {}).sort(), hostBridge: !!window.dublineDesktop,
      requireType: typeof require, desktopUi: document.body.classList.contains('desktop-mode') }));
    assert.deepEqual(state, { language: expected, preferences: ['language', 'setLanguage'], hostBridge: false, requireType: 'undefined', desktopUi: false });
    if (next) {
      await page.evaluate(async code => { await DublineI18n.setLanguage(code); await dublinePreferences.setLanguage(code); }, next);
      assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'language.json'), 'utf8')), next);
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
  let server;
  try {
    assert.ok(fs.existsSync(executable), 'Build with npm run dist first');
    fs.writeFileSync(path.join(userData, 'language.json'), JSON.stringify('uk'));
    server = await startServer();
    await guest(server.url('language', '127.0.0.1'), userData, 'uk', 'ru');
    await guest(server.url('language', 'localhost'), userData, 'ru');
    console.log('Packaged guest smoke passed: language persistence across origins; language-only bridge; no host UI or Node access.');
  } finally {
    if (server) await server.cleanup();
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
