// Real main/preloads, isolated profiles, no downloads or changes to installed apps.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { launch } = require('./packaged-test-driver');
const { until, browserFor, workspace, stop } = require('./electron-portable-update-smoke');
const root = path.resolve(__dirname, '..');
const betaDefault = require('../src/update-version').isBeta(require('../package.json').version);
async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-beta-ui-'));
  const profile = path.join(temporary, 'profile'), shots = path.join(root, 'audit', 'beta-ui');
  fs.mkdirSync(shots, { recursive: true });
  let running, browser;
  const start = async (folder, beforeStart = '') => {
    running = await launch(require('electron'), folder, beforeStart, { appPath: root });
    browser = await browserFor(running, { defaultViewport: null, protocolTimeout: 30000 });
    return until(async () => (await browser.pages()).find(page => page.url().endsWith('electron-launcher.html')));
  };
  const checked = page => page.$eval('#experimentalUpdates', node => node.checked);
  const toggle = async (page, value) => {
    await page.focus('#experimentalUpdates'); await page.keyboard.press('Space');
    await until(async () => await checked(page) === value && !await page.$eval('#experimentalUpdates', node => node.disabled));
  };
  try {
    let launcher = await start(profile);
    await launcher.waitForSelector('#experimentalUpdates');
    assert.equal(await checked(launcher), betaDefault);
    assert.deepEqual(await launcher.evaluate(() => dublineLauncher.getUpdatePreferences()), { experimental: betaDefault, supported: true });
    for (const language of ['en', 'ru', 'uk']) {
      await launcher.select('#language', language);
      const text = await launcher.$eval('.update-channel', node => node.textContent);
      assert.match(text, /experimental|экспериментальные|експериментальні/);
      assert.match(text, /unstable|нестабильно|нестабільно/);
    }
    if (!await checked(launcher)) await toggle(launcher, true);
    else assert.equal((await launcher.evaluate(() => dublineLauncher.setExperimentalUpdates(true))).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'update-preferences.json'))).experimental, true);
    if (process.argv.includes('--screens')) await launcher.screenshot({ path: path.join(shots, 'launcher.png') });
    await launcher.reload(); await launcher.waitForSelector('#experimentalUpdates'); assert.equal(await checked(launcher), true);
    const page = await workspace(browser); await page.waitForSelector('#experimentalUpdates', { visible: false });
    assert.equal(await checked(page), true);
    assert.equal(await page.$eval('#experimentalUpdates', node => node.closest('#desktopAboutCard') !== null), true);
    await page.evaluate(() => { closeHelpModal(); openSettingsModal(); switchSettingsTab('user'); openSettingsCategory('user', 'interface'); });
    for (const width of [900, 1440]) {
      await running.inspector.evaluate("require('electron').BrowserWindow.getAllWindows().find(w => /^http:/.test(w.webContents.getURL())).setContentSize(" + width + ", 850)");
      await until(() => page.evaluate(width => innerWidth === width, width));
      for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
        await page.evaluate(async (theme, language) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); }, theme, language);
        await page.$eval('.update-channel', node => node.scrollIntoView({ block: 'center' }));
        const layout = await page.$eval('.update-channel', node => {
          const box = node.getBoundingClientRect(), input = node.querySelector('input').getBoundingClientRect(), title = node.querySelector('span').getBoundingClientRect();
          return { overflow: node.scrollWidth - node.clientWidth, left: box.left, right: box.right, viewport: innerWidth, gap: input.left - title.right, toggleWidth: input.width, label: node.querySelector('label').textContent };
        });
        assert.ok(layout.overflow <= 1 && layout.left >= 0 && layout.right <= layout.viewport, JSON.stringify({ width, theme, language, ...layout }));
        assert.ok(layout.gap >= 8 && layout.toggleWidth === 40, JSON.stringify(layout));
      }
    }
    console.log('36 native layouts passed.');
    // Failed persistence must restore the actual state in the UI and main process.
    fs.mkdirSync(path.join(profile, 'update-preferences.json.new'));
    await page.click('#experimentalUpdates');
    await until(async () => /Не вдалося/.test(await page.$eval('#experimentalUpdatesHelp', node => node.textContent)));
    assert.equal(await checked(page), true);
    assert.equal((await page.evaluate(() => dublineDesktop.getUpdatePreferences())).experimental, true);
    fs.rmdirSync(path.join(profile, 'update-preferences.json.new'));
    await toggle(page, false);
    await stop(running, browser); running = browser = null;
    launcher = await start(profile); await launcher.waitForSelector('#experimentalUpdates'); assert.equal(await checked(launcher), false);
    await toggle(launcher, true);
    await stop(running, browser); running = browser = null;
    launcher = await start(profile); await launcher.waitForSelector('#experimentalUpdates'); assert.equal(await checked(launcher), true);
    await stop(running, browser); running = browser = null;
    launcher = await start(path.join(temporary, 'second-profile')); await launcher.waitForSelector('#experimentalUpdates'); assert.equal(await checked(launcher), betaDefault);
    await stop(running, browser); running = browser = null;
    // Override only distribution identity; exercise the production Steam gate/IPC.
    const distribution = path.join(root, 'src', 'electron-distribution.js');
    launcher = await start(path.join(temporary, 'steam-profile'), 'globalThis.__dublineTestRequire(' + JSON.stringify(distribution) + ').readDistribution = () => ({channel:"steam"});');
    await until(async () => (await launcher.evaluate(() => dublineLauncher.getUpdatePreferences())).supported === false);
    assert.equal(await launcher.$('#experimentalUpdates'), null);
    assert.equal((await launcher.evaluate(() => dublineLauncher.setExperimentalUpdates(true))).code, 'unsupported');
    await stop(running, browser); running = browser = null;
    console.log('Update preference native smoke passed: real IPC/preloads, keyboard toggle, reload/restart persistence, separate profiles, failed-save recovery, Steam gate and 36 theme/language/width layouts.');
  } catch (error) { console.error(running?.log()); throw error; }
  finally { await stop(running, browser); fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
