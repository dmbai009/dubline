const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture, waitFor } = require('../e2e/helpers');
const { chromium } = require(require.resolve('playwright-core', { paths: [process.cwd(), path.resolve('audit/fx-tools')] }));
async function main() {
  let server, browser, pw;
  const out = path.resolve('audit/toggle-workspace'); fs.mkdirSync(out, { recursive: true }); const shots = [];
  try {
    server = await startServer(); browser = await launchBrowser(server.port); const setup = await openPlayer(browser, server.url('toggle-workspace'), 'Host'); await loadFixture(setup);
    pw = await chromium.connectOverCDP(browser.wsEndpoint()); const page = pw.contexts().flatMap(c => c.pages()).find(p => p.url() === setup.url());
    const shot = async name => { await page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' }); shots.push(name); };
    for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(async ({ theme, language }) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); openFilesModal(); switchFilesTab('export'); }, { theme, language });
      await page.waitForFunction(() => videoExportPanel.dataset.ready === 'true');
      // Native export's existing completion control, exposed only for this browser visual matrix.
      await page.evaluate(() => { videoExportSoundLabel.hidden = false; videoExportSound.checked = true; });
      assert.ok(await page.locator('#videoExportSoundLabel').evaluate(n => { const input = n.querySelector('input'), text = n.querySelector('span'), a = input.getBoundingClientRect(), b = text.getBoundingClientRect(); return getComputedStyle(input).appearance === 'none' && a.width === 40 && b.left - a.right >= 8 && b.right <= n.getBoundingClientRect().right + 1; }));
      await shot(`export-${theme}-${language}`);
      await page.evaluate(async () => { closeFilesModal(); openSettingsModal(); await switchSettingsTab('user'); await openSettingsCategory('user', 'audio'); settingsLocalDuck.checked = true; settingsLocalDuck.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.locator('#settingsLocalDuckOn').scrollIntoViewIfNeeded(); await shot(`duck-${theme}-${language}`); await page.evaluate(() => closeSettingsModal());
      await page.locator('#timelineScopeFilter').selectOption('choose'); await page.locator('#timelineChooseFilter').click();
      assert.ok(await page.locator('[data-filter-role]').first().evaluate(n => getComputedStyle(n).appearance === 'none' && n.getBoundingClientRect().width === 40));
      assert.ok(await page.locator('#timelineFilterPicker').evaluate(n => { const labels = [...n.querySelectorAll('label')].map(n => n.getBoundingClientRect()); return labels.every((b, i) => !i || b.top >= labels[i - 1].bottom - 1); }));
      await shot(`roles-${theme}-${language}`); await page.keyboard.press('Escape'); await page.locator('#timelineScopeFilter').selectOption('all');
    }
    for (const [width, zoom] of [[640, 1], [1024, 1.5]]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(zoom => { document.body.style.zoom = String(zoom); openFilesModal(); switchFilesTab('export'); }, zoom); await page.waitForFunction(() => videoExportPanel.dataset.ready === 'true');
      await page.evaluate(() => { videoExportSoundLabel.hidden = false; });
      assert.ok(await page.locator('#videoExportSoundLabel').evaluate(n => n.scrollWidth <= n.clientWidth + 1)); await shot(`export-${width}-${zoom}`); await page.evaluate(() => closeFilesModal());
    }
    assert.deepEqual(setup.errors, []); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ shots }, null, 2)); console.log('PASS: ' + shots.length + ' Playwright screenshots; themes/locales, completion/duck/filter toggles and narrow/zoomed layout.');
  } finally { if (pw) await pw.close().catch(() => {}); await browser?.close(); await server?.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
