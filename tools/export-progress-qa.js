// Real export held after its first completed audio window for stable Playwright inspection.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect } = require('../e2e/helpers');
const { chromium } = require(require.resolve('playwright-core', { paths: [process.cwd(), path.resolve('audit/fx-tools')] }));
async function main() {
  let server, browser, pw; const shots = [], out = path.resolve('audit/export-progress'); fs.mkdirSync(out, { recursive: true });
  try {
    server = await startServer(); browser = await launchBrowser(server.port); const setup = await openPlayer(browser, server.url('progress-visual'), 'Host'); await loadFixture(setup); await claimAndSelect(setup, 1);
    await setup.evaluate(async () => { const b = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 }); for (let i = 0; i < b.length; i++) b.getChannelData(0)[i] = .08 * Math.sin(i * .1); await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: 1, nick: myName, audioStart: 0, duration: 1, trimStart: .1, trimEnd: .9, blob: new Blob([audioBufferToWav(b)], { type: 'audio/wav' }), createdAt: Date.now() }); });
    await (await setup.createCDPSession()).send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: out });
    pw = await chromium.connectOverCDP(browser.wsEndpoint()); const page = pw.contexts().flatMap(c => c.pages()).find(p => p.url() === setup.url());
    await page.evaluate(() => {
      window.qaChunks = DublineVideoExportAudio.chunks; window.qaClock = DublineExportProgress.create; window.qaOffset = 0;
      DublineExportProgress.create = () => qaClock(() => performance.now() + qaOffset);
      DublineVideoExportAudio = { ...DublineVideoExportAudio, chunks: async function* (...args) { for await (const chunk of qaChunks(...args)) { yield chunk; if (chunk.end === 8) await new Promise(resolve => { window.qaRelease = resolve; }); } } };
      openFilesModal(); switchFilesTab('export');
    }); await page.waitForFunction(() => videoExportPanel.dataset.ready === 'true'); await page.locator('#startRenderBtn').click(); await page.waitForFunction(() => !!window.qaRelease);
    assert.match(await page.locator('[data-phase=audio] strong').textContent(), /0:08 \/ 0:12/);
    const shot = async name => { await page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' }); shots.push(name); };
    for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
      await page.setViewportSize({ width: 1280, height: 900 }); await page.evaluate(async ({ theme, language }) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); }, { theme, language });
      await page.locator('#renderProgressBox').scrollIntoViewIfNeeded(); await shot(`running-${theme}-${language}`);
      assert.ok(await page.locator('#renderProgressBox').evaluate(n => n.scrollWidth <= n.clientWidth + 1));
      assert.equal(await page.locator('#renderProgressActivity').getAttribute('data-waiting'), 'false');
    }
    for (const [width, zoom] of [[640, 1], [1024, 1.5]]) for (const language of ['en', 'ru', 'uk']) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(async ({ zoom, language }) => { document.body.style.zoom = String(zoom); await DublineI18n.setLanguage(language); }, { zoom, language });
      await page.locator('#renderProgressBox').scrollIntoViewIfNeeded(); assert.ok(await page.locator('#renderProgressBox').evaluate(n => n.scrollWidth <= n.clientWidth + 1)); await shot(`narrow-${width}-${zoom}-${language}`);
    }
    await page.evaluate(() => { qaOffset = 20000; }); await page.waitForFunction(() => renderProgressActivity.dataset.waiting === 'true'); await shot('no-new-progress-warning');
    await page.locator('#cancelVideoExportBtn').click(); await page.evaluate(() => qaRelease()); await page.waitForFunction(() => !renderInProgress && renderStatusText.dataset.state === 'cancelled'); await shot('cancelled');
    assert.deepEqual(setup.errors, []); fs.writeFileSync(path.join(out, 'visual-results.json'), JSON.stringify({ shots }, null, 2)); console.log('PASS: ' + shots.length + ' Playwright screenshots: actual 8/12-second audio progress, six themes, three languages, narrow/zoomed layouts, quiet warning and cancellation.');
  } finally { if (pw) await pw.close().catch(() => {}); await browser?.close(); await server?.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
