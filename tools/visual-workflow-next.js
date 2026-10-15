const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor, waitUntil, buildFixturePack } = require('../e2e/helpers');
async function prepare(page) {
  await claimAndSelect(page, 1);
  await page.evaluate(async () => {
    for (const amplitude of [.025, .07]) {
      const buffer = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 });
      for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = amplitude * Math.sin(i * .11);
      await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: 1, nick: myName, audioStart: 0, duration: 1, trimStart: .1, trimEnd: .9, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() });
    }
    for (let i = 0; i < 30; i++) {
      const result = await new Promise(resolve => socket.emit('voice_preset_update', { sessionId: session.activeSessionId, action: 'create', id: 'visual-' + i, name: `${i + 1} · Long preset / Длинный пресет / Довгий пресет`, revision: 0, settings: { effects: [{ id: 'phone', type: 'telephone', amount: .5, enabled: true, parameters: {} }] } }, resolve)); if (!result.ok) throw Error(JSON.stringify(result));
    }
    const line = session.lines[0], result = await new Promise(resolve => socket.emit('voice_update', { sessionId: session.activeSessionId, scope: 'takes', action: 'replace', editPreset: true, presetRevision: 1, settings: DublineVoiceChain.take(DublineVoicePresets.link(line, session, 'visual-0', false)), takes: [{ lineId: 1, character: line.character, takeId: line.takeId, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision || 0 }] }, resolve)); if (!result.ok) throw Error(JSON.stringify(result));
  });
  await waitFor(page, () => session.lines[0].voicePresetId === 'visual-0' && session.lines[0].takeHistory.length === 1);
}
async function capture(page, destination, resize) {
  fs.mkdirSync(destination, { recursive: true }); const results = [];
  for (const theme of process.argv.includes('--quick') ? ['light'] : ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of process.argv.includes('--quick') ? ['ru'] : ['en', 'ru', 'uk']) for (const zoom of [1, 1.25, 1.5]) {
    await resize(820, 900, zoom);
    await page.evaluate(async (theme, language) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); }, theme, language);
    for (const panel of ['presets', 'review', 'levels']) {
      await page.evaluate(async panel => {
        await closeSettingsModal(); if (fxDialog.open) fxCancel.click(); if (sceneReviewDialog.open) sceneReviewClose.click();
        if (panel === 'presets') { DublineVoiceEditor.open('visual-0', 'preset'); fxPresets.open = true; }
        if (panel === 'review') sceneReviewBtn.click();
        if (panel === 'levels') { openSettingsModal(); await switchSettingsTab('player'); await openSettingsCategory('player', 'audio'); }
      }, panel);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 260)));
      const geometry = await page.evaluate(panel => {
        const node = panel === 'levels' ? document.querySelector('#settingsModal .modal-card') : document.getElementById({ presets: 'fxDialog', review: 'sceneReviewDialog' }[panel]); const box = node.getBoundingClientRect(), button = panel === 'levels' ? normalizeVoices.closest('.switch-ui') : node.querySelector('.fx-footer button'); const footer = button.getBoundingClientRect();
        return { fits: box.left >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1, overflow: node.scrollWidth > node.clientWidth + 1, footer: footer.height > 0 && footer.top >= box.top - 1 && footer.bottom <= box.bottom + 1, missing: [...node.querySelectorAll('[data-i18n]')].filter(item => item.getBoundingClientRect().height && item.textContent === item.dataset.i18n).map(item => item.dataset.i18n) };
      }, panel);
      const filename = `${theme}-${language}-${Math.round(zoom * 100)}-${panel}.png`; await page.screenshot({ path: path.join(destination, filename) }); assert.ok(geometry.fits && !geometry.overflow && geometry.footer && !geometry.missing.length, JSON.stringify({ filename, geometry })); results.push({ filename, geometry });
    }
  }
  await page.evaluate(() => { closeSettingsModal(); if (fxDialog.open) fxCancel.click(); if (sceneReviewDialog.open) sceneReviewClose.click(); });
  await resize(640, 850, 1.5); await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await page.evaluate(() => { sceneReviewBtn.click(); }); await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => sceneReviewDialog.contains(document.activeElement))); await page.screenshot({ path: path.join(destination, 'narrow-keyboard-reduced-motion.png') }); await page.keyboard.press('Escape');
  fs.writeFileSync(path.join(destination, 'results.json'), JSON.stringify(results, null, 2)); assert.deepEqual(page.errors, []);
}
async function main() {
  let server, browser, runtime; const native = process.argv.includes('--native') || process.argv.includes('--packaged'), profile = native ? fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-workflow-visual-')) : null;
  try {
    let page;
    if (native) {
      const executable = process.argv.includes('--packaged') ? path.resolve('dist/win-unpacked/Dubline.exe') : require('electron'); runtime = await require('./packaged-test-driver').launch(executable, profile, '', { appPath: process.argv.includes('--packaged') ? '' : path.resolve('.') });
      const puppeteer = require('puppeteer-core'); await waitUntil(async () => { try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${runtime.browserPort}`, defaultViewport: null }); return true; } catch { return false; } });
      let launcher; await waitUntil(async () => { launcher = (await browser.pages()).find(tab => tab.url().includes('electron-launcher.html')); return !!launcher; }); await launcher.select('#language', 'en'); await launcher.$eval('[data-mode=porthole]', node => node.click()); await launcher.$eval('#startHost', node => node.click());
      await waitUntil(async () => { page = (await browser.pages()).find(tab => /^http:\/\/127\.0\.0\.1:\d+\//.test(tab.url())); return !!page; }); page.errors = []; page.on('pageerror', error => page.errors.push(error.message)); await waitFor(page, () => !!window.dublineDesktop && socket.connected); await page.evaluate(() => { modalNickInput.value = 'Native workflow'; handleNickSubmit(new Event('submit', { cancelable: true })); closeHelpModal(); }); await waitFor(page, () => p2pConsentDialog.open); await page.click('#p2pConsentDecline'); await (await page.$('#zipInput')).uploadFile(buildFixturePack()); await waitFor(page, () => session.loaded && video.readyState >= 2);
    } else { server = await startServer(); browser = await launchBrowser(server.port); page = await openPlayer(browser, server.url('visual-workflow-next'), 'Host'); await loadFixture(page); }
    await prepare(page);
    if (native) {
      const result = await page.evaluate(async () => {
        const response = await queueEditorRequest(() => ['project_audio_update', { channel: 'settings', field: 'normalizeVoices', value: true, revision: session.projectAudio.revision }]); if (!response.ok) throw Error(JSON.stringify(response));
        const line = session.lines[0], plain = await audio.prepareTake({ ...line, _exportLevel: false }), leveled = await audio.prepareTake(line), snapshot = createExportSnapshot(); await requireExportTake(snapshot.takes[0]);
        await audio.previewTake(line); audio.stopPreview(); return { same: plain.buffer === leveled.buffer, gain: leveled.gain, exported: snapshot.takes[0]._levelGain, frozen: snapshot.takes[0]._exportLevel, stats: DublineSpeechAnalysis.stats() };
      }); assert.ok(result.same && result.frozen && Number.isFinite(result.gain)); assert.equal(result.gain, result.exported); console.log('Packaged live presets, worker, optional levels, audition and frozen export verified: ' + JSON.stringify(result));
    }
    const resize = native ? async (width, height, zoom) => { await runtime.inspector.evaluate(`require('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http')).setContentSize(${width},${height});require('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http')).webContents.setZoomFactor(${zoom});`); } : async (width, height, zoom) => { await page.setViewport({ width, height }); await page.evaluate(zoom => { document.body.style.zoom = String(zoom); }, zoom); };
    const destination = path.resolve('audit/live-presets/visual-' + (process.argv.includes('--packaged') ? 'packaged' : native ? 'native' : 'browser') + (process.argv.includes('--quick') ? '-quick' : '')); await capture(page, destination, resize); console.log(`Verified ${process.argv.includes('--quick') ? 12 : 216} actual screenshots: ${destination}`);
  } finally {
    if (runtime) { await runtime.inspector.evaluate("require('electron').app.exit(0)").catch(() => {}); runtime.inspector.close(); runtime.child.kill(); }
    await browser?.close().catch(() => {}); await server?.cleanup();
    if (profile) { const target = path.resolve(profile); if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(target).startsWith('dubline-workflow-visual-')) throw Error('Unexpected temporary profile'); fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { prepare, capture };
