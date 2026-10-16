// Real studio visual verification through Playwright; no user projects are used.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture } = require('../e2e/helpers');
const { chromium } = process.env.DUBLINE_PLAYWRIGHT_ROOT
  ? require(path.join(process.env.DUBLINE_PLAYWRIGHT_ROOT, 'node_modules', 'playwright-core'))
  : require(require.resolve('playwright-core', { paths:[process.cwd(), path.resolve('audit/fx-tools')] }));
async function main() {
  let server, browser, pw;
  const out = path.resolve('audit/subtitle-export'); fs.mkdirSync(out, { recursive:true });
  let shots = 0;
  try {
    server = await startServer(); browser = await launchBrowser(server.port);
    const setup = await openPlayer(browser, server.url('subtitle-qa'), 'Host'); await loadFixture(setup);
    pw = await chromium.connectOverCDP(browser.wsEndpoint());
    const page = pw.contexts().flatMap(c => c.pages()).find(p => p.url() === setup.url());
    for (const theme of ['midnight','graphite','light','ocean','forest','sunset']) {
      for (const language of ['en','ru','uk']) {
        await page.setViewportSize({ width:1280, height:900 });
        await page.evaluate(async ({ theme, language }) => {
          document.body.style.zoom = ''; document.documentElement.dataset.theme = theme;
          await DublineI18n.setLanguage(language); openFilesModal(); switchFilesTab('export');
        }, { theme, language });
        const card = page.locator('#subtitleExportCard'); await card.scrollIntoViewIfNeeded();
        assert.ok(await card.evaluate(e => e.scrollWidth <= e.clientWidth));
        for (const format of ['srt','ass','vtt']) {
          const button = card.locator(`[data-subtitle-format="${format}"]`);
          assert.ok((await button.getAttribute('title')).length > 60); await button.hover();
        }
        await page.screenshot({ path:path.join(out, `formats-${theme}-${language}.png`) }); shots++;
        await page.evaluate(() => { closeFilesModal(); layout.top = 280; applyLayout(); fitTimeline(); DublineTimelineRange.set(1.234, 10.567); });
        for (const [width, zoom] of [[1920,1],[900,1],[1280,1.5]]) {
          await page.setViewportSize({ width, height:900 });
          await page.evaluate(zoom => { document.body.style.zoom = String(zoom); applyLayout(); }, zoom);
          const geometry = await page.locator('.timeline-footer-controls').evaluate(e => {
            const tools = e.querySelector('.timeline-range-tools').getBoundingClientRect(), scale = e.querySelector('.zoom-controls').getBoundingClientRect(), footer = e.getBoundingClientRect();
            return { fits:e.scrollWidth<=e.clientWidth, left:tools.left>=footer.left-1, before:tools.right<=scale.left+1, row:Math.abs(tools.top+tools.height/2-scale.top-scale.height/2)<2 };
          });
          assert.ok(Object.values(geometry).every(Boolean), JSON.stringify({ theme,language,width,zoom,geometry }));
          await page.screenshot({ path:path.join(out, `range-${theme}-${language}-${width}-${zoom}.png`) }); shots++;
        }
      }
    }
    assert.deepEqual(setup.errors, []);
    console.log(`PASS: ${shots} Playwright screenshots; six themes, three languages, narrow panels and 150% scaling.`);
  } finally { await pw?.close().catch(() => {}); await browser?.close(); await server?.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
