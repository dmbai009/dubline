const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture } = require('../e2e/helpers');

async function captureScreens(page, destination, resize) {
  fs.mkdirSync(destination, { recursive: true });
  for (const [width, height] of [[1024, 768], [1280, 720], [1920, 1080]]) {
    await resize(width, height);
    for (const language of ['ru', 'en', 'uk']) {
      await page.evaluate(language => i18n.setLanguage(language), language);
      await page.evaluate(() => { closeSettingsModal(); closeHelpModal(); session.title = 'Эпизод 12 — Подготовка сцены и запись голосов — A very long project title'; renderSessions(); });
      const failures = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('header button, header input')].filter(element => element.getBoundingClientRect().width);
        return controls.filter(element => {
          const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return r.left < -1 || r.right > innerWidth + 1 || !element.contains(hit);
        }).map(element => element.outerHTML);
      });
      assert.deepEqual(failures, [], `header ${width} ${language}`);
      await page.screenshot({ path: path.join(destination, `${width}-${language}-studio.png`) });
      await page.evaluate(() => { openSettingsModal(); switchSettingsTab('user'); openSettingsCategory('user', 'audio'); });
      const overflow = await page.$eval('#settingsModal .modal-card', card => card.scrollWidth > card.clientWidth + 1);
      assert.equal(overflow, false, `settings ${width} ${language}`);
      await page.screenshot({ path: path.join(destination, `${width}-${language}-audio.png`) });
      await page.evaluate(() => openSettingsCategory('user', 'storage'));
      await page.screenshot({ path: path.join(destination, `${width}-${language}-storage.png`) });
      await page.evaluate(() => { closeSettingsModal(); openHelpModal(); });
      await page.screenshot({ path: path.join(destination, `${width}-${language}-help.png`) });
    }
  }
  await page.evaluate(() => { closeHelpModal(); closeSettingsModal(); });
}
async function main() {
  let server, browser;
  try {
    server = await startServer(); browser = await launchBrowser(server.port);
    const page = await openPlayer(browser, server.url('ui-visual'), 'Alice'); await loadFixture(page);
    const destination = path.join(__dirname, '..', 'build', 'ui-cleanup-qa', 'browser');
    await captureScreens(page, destination, (width, height) => page.setViewport({ width, height }));
    assert.deepEqual(page.errors, []); console.log(`Browser UI screenshots: ${destination}`);
  } finally { await browser?.close(); await server?.cleanup(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { captureScreens };
