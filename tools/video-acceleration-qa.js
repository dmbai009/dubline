const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture } = require('../e2e/helpers');
const { chromium } = require(require.resolve('playwright-core', { paths: [process.cwd(), path.resolve('audit/fx-tools')] }));
async function main() {
  let server, browser, pw; const out = path.resolve('audit/video-acceleration'), shots = []; fs.mkdirSync(out, { recursive: true });
  try {
    server = await startServer(); browser = await launchBrowser(server.port); const setup = await openPlayer(browser, server.url('hw-visual'), 'Host'); await loadFixture(setup);
    pw = await chromium.connectOverCDP(browser.wsEndpoint()); const page = pw.contexts().flatMap(c => c.pages()).find(p => p.url() === setup.url());
    for (const theme of ['midnight','graphite','light','ocean','forest','sunset']) for (const language of ['en','ru','uk']) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(async ({theme,language}) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); openSettingsModal(); await switchSettingsTab('user'); await openSettingsCategory('user','interface'); }, {theme,language});
      await page.locator('#videoAccelerationCard').scrollIntoViewIfNeeded();
      assert.ok(await page.locator('#videoAccelerationCard').evaluate(card => { const b=card.getBoundingClientRect(), controls=[...card.querySelectorAll('label,select,.dropdown')].filter(n=>n.getBoundingClientRect().width>0); return card.scrollWidth<=card.clientWidth+1 && controls.every(n=>{const a=n.getBoundingClientRect();return a.left>=b.left-1&&a.right<=b.right+1;}); }));
      const name=`${theme}-${language}`; await page.screenshot({path:path.join(out,name+'.png'),animations:'disabled'}); shots.push(name);
    }
    for (const width of [640,900]) {
      await page.setViewportSize({width,height:900}); await page.evaluate(()=>{document.body.style.zoom='1.5';});
      await page.locator('#videoAccelerationCard').scrollIntoViewIfNeeded();
      assert.ok(await page.locator('#videoAccelerationCard').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
      const name=`narrow-${width}-150`;await page.screenshot({path:path.join(out,name+'.png'),animations:'disabled'});shots.push(name);
    }
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({shots},null,2)); console.log('PASS: '+shots.length+' Playwright screenshots, six themes, EN/RU/UK, narrow panels and 150% zoom.');
  } finally { await pw?.close(); await browser?.close(); await server?.cleanup(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
