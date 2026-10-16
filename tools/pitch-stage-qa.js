// Real isolated studio, Playwright geometry and theme/locale screenshots.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect } = require('../e2e/helpers');
const { chromium } = process.env.DUBLINE_PLAYWRIGHT_ROOT
  ? require(path.join(process.env.DUBLINE_PLAYWRIGHT_ROOT, 'node_modules', 'playwright-core'))
  : require(require.resolve('playwright-core', { paths: [process.cwd(), path.resolve('audit/fx-tools')] }));
async function main() {
  let server, browser, pw, shots = 0;
  const out = path.resolve('audit/pitch-stage'); fs.mkdirSync(out, { recursive: true });
  try {
    server = await startServer(); browser = await launchBrowser(server.port);
    const setup = await openPlayer(browser, server.url('pitch-qa'), 'Host'); await loadFixture(setup); await claimAndSelect(setup, 1);
    pw = await chromium.connectOverCDP(browser.wsEndpoint());
    const page = pw.contexts().flatMap(c => c.pages()).find(p => p.url() === setup.url());
    await page.evaluate(() => DublineVoiceEditor.open(1, 'takes'));
    for (const count of [1, 4, 8]) {
      if (await page.locator('#fxClearChain').isEnabled()) await page.locator('#fxClearChain').click();
      for (const type of ['pitch', 'radio', 'telephone', 'robot', 'echo', 'behindDoor', 'megaphone', 'thoughts'].slice(0, count)) await page.locator(`[data-fx-type=${type}]`).click();
      await page.locator('[data-action=semitones]').evaluate(node => { node.value = '-12'; node.dispatchEvent(new Event('input', { bubbles: true })); });
      for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.evaluate(async ({ theme, language }) => { document.body.style.zoom = ''; document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); }, { theme, language });
        await page.waitForTimeout(40);
        const geometry = await page.evaluate(() => {
          const dialog = document.getElementById('fxDialog'), bounds = dialog.getBoundingClientRect();
          const cards = [...document.querySelectorAll('#fxRows .fx-item')].map(node => node.getBoundingClientRect());
          return { fits: bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1, overflow: dialog.scrollWidth > dialog.clientWidth + 1, fourColumns: cards.length < 4 || cards.slice(0, 4).every(card => Math.abs(card.y - cards[0].y) < 1), old: !!document.getElementById('fxPitch'), value: document.querySelector('[data-action=semitones]').value };
        });
        assert.ok(geometry.fits && !geometry.overflow && geometry.fourColumns && !geometry.old && geometry.value === '-12', JSON.stringify({ count, theme, language, geometry }));
        await page.locator('#fxDialog').screenshot({ path: path.join(out, `${count}-${theme}-${language}.png`), animations: 'disabled' }); shots++;
      }
    }
    for (const width of [640, 900]) for (const zoom of [1, 1.5]) {
      await page.setViewportSize({ width, height: 800 }); await page.evaluate(zoom => { document.body.style.zoom = String(zoom); }, zoom);
      await page.waitForTimeout(60);
      assert.ok(await page.locator('#fxDialog').evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && node.scrollWidth <= node.clientWidth + 1; }));
      await page.locator('#fxDialog').screenshot({ path: path.join(out, `narrow-${width}-${zoom}.png`), animations: 'disabled' }); shots++;
    }
    console.log(JSON.stringify({ screenshots: shots, output: out }));
  } finally { await pw?.close(); await browser?.close(); await server?.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
