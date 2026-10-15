const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor, waitUntil } = require('./helpers');
describe('next-line navigation, ordinary take history, scene checks and export states', { skip: skipReason, timeout: 240000 }, () => {
  let server, browser, host, actor;
  const record = async (id, wait = true) => { await claimAndSelect(actor, id); await actor.evaluate(async id => { const buffer = new AudioBuffer({ length: 96000, sampleRate: 48000, numberOfChannels: 1 }); for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = .09 * Math.sin(i * .087); return submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: id, nick: myName, audioStart: 0, trimStart: .1, trimEnd: 1.8, duration: 2, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() }); }, id); if (wait) await waitFor(actor, id => !!session.lines.find(line => line.id === id).audioUrl && !pendingTakeLines.size, 15000, id); };
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); host = await openPlayer(browser, server.url('workflow-next'), 'Host'); actor = await openPlayer(browser, server.url('workflow-next'), 'Actor'); await loadFixture(host); await waitFor(actor, () => session.loaded); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('a scene summary treats unfinished dialogue as warnings and checks metadata without downloading takes', async () => {
    const report = await host.evaluate(() => DublineSceneReview.snapshot()); assert.equal(report.recorded, 0); assert.equal(report.total, 4); assert.equal(report.errors.length, 0);
    await host.click('#sceneReviewBtn'); assert.equal(await host.$eval('#sceneReviewDialog', node => node.open), true); await host.click('#sceneReviewCheck'); await waitFor(host, () => document.getElementById('sceneReviewStatus').textContent === t('review.checked')); await host.click('#sceneReviewClose');
  });
  test('next line navigates only owned unrecorded dialogue without starting capture', async () => {
    await actor.evaluate(() => socket.emit('claim_character', { sessionId: session.activeSessionId, character: 'Friend' })); await waitFor(actor, () => session.characterClaims.Friend === myName); await claimAndSelect(actor, 2);
    assert.equal(await actor.$('#sequenceRecording'), null); assert.equal(await actor.$('#takeCompareDialog'), null);
    await record(2); await waitFor(actor, () => !document.getElementById('nextUnrecordedLine').disabled); await actor.click('#nextUnrecordedLine');
    assert.equal(await actor.evaluate(() => selectedLine.id), 4); assert.equal(await actor.evaluate(() => recordState), 'idle'); assert.equal(await actor.evaluate(() => video.currentTime), 9.5);
  });
  test('pending upload blocks navigation and completed owned roles disable the button after retry', async () => {
    await actor.evaluate(() => { window.restoreSequenceUpload = DublineNetwork.upload; DublineNetwork.upload = async () => null; });
    try { await record(4, false); await waitFor(actor, () => document.getElementById('nextUnrecordedLine').disabled); assert.equal(await actor.evaluate(() => selectedLine.id), 4); }
    finally { await actor.evaluate(() => { DublineNetwork.upload = restoreSequenceUpload; }); }
    await actor.evaluate(async () => { for (const entry of pendingTakes.values()) await sendTake(entry); }); await waitFor(actor, () => !pendingTakeLines.size && !!session.lines.find(l => l.id === 4).audioUrl && document.getElementById('nextUnrecordedLine').disabled);
  });
  test('ordinary history previews and restores using the original acknowledged history operation', async () => {
    await record(2); await actor.$eval('.take-history', node => { node.open = true; });
    const chosen = await actor.$eval('[data-history-action=play]', node => node.dataset.historyTake); await actor.click('[data-history-action=play]'); await waitFor(actor, () => !!document.querySelector('[data-history-action=play].active'));
    assert.equal(await actor.$('[data-history-compare]'), null); assert.equal(await actor.$eval('.take-history', node => node.parentElement.classList.contains('insp-recording')), true);
    await actor.click('[data-history-action=restore]'); await waitFor(actor, id => session.lines.find(line => line.id === 2).takeId === id, 10000, chosen);
  });
  test('file diagnostics respect hidden-take access and never report protected recordings to the host', async () => {
    await host.evaluate(() => socket.emit('set_blind_mode', { sessionId: session.activeSessionId, enabled: true })); await waitFor(host, () => session.blindMode);
    const response = await host.evaluate(async () => (await fetch('/api/scene-review?' + new URLSearchParams({ room: currentRoom, clientId, sessionId: session.activeSessionId }))).json()); assert.equal(response.takes.length, 0);
    await host.evaluate(() => socket.emit('set_blind_mode', { sessionId: session.activeSessionId, enabled: false })); await waitFor(host, () => !session.blindMode);
  });
  test('a missing file is distinct from unfinished dialogue; Go reveals its line without changing saved filters', async () => {
    await waitFor(host, () => !!session.lines.find(line => line.id === 4).audioUrl); const url = await host.evaluate(() => session.lines.find(line => line.id === 4).audioUrl), file = path.resolve(server.dirs.uploads, decodeURIComponent(url.slice('/uploads/'.length))); assert.ok(file.startsWith(path.resolve(server.dirs.uploads) + path.sep)); fs.renameSync(file, file + '.hidden');
    try { await host.select('#timelineStatusFilter', 'unrecorded'); await host.click('#sceneReviewBtn'); await host.click('#sceneReviewCheck'); await waitFor(host, () => DublineSceneReview.snapshot().errors.some(issue => issue.lineId === 4)); const buttons = await host.$$('#sceneReviewIssues button'); const target = await Promise.all(buttons.map(button => button.evaluate(node => node.textContent))); await buttons[target.findIndex(text => text.startsWith('#4'))].click(); assert.equal(await host.evaluate(() => selectedLine.id), 4); assert.equal(await host.$eval('#timelineStatusFilter', node => node.value), 'unrecorded'); }
    finally { fs.renameSync(file + '.hidden', file); await host.evaluate(() => DublineSceneReview.checkFiles()); await host.select('#timelineStatusFilter', 'all'); }
  });
  test('export hides excessive settings and explains unavailable source options through the shared dropdown', async () => {
    await actor.evaluate(() => { openFilesModal(); switchFilesTab('export'); }); await waitFor(actor, () => videoExportPanel.dataset.ready === 'true'); await actor.click('[name=videoExportMode][value=custom]'); await waitFor(actor, () => !startRenderBtn.disabled);
    assert.equal(await actor.$eval('#videoExportResolution', node => [...node.options].filter(option => +option.value >= 1080).every(option => option.hidden && option.disabled)), true); assert.equal(await actor.$eval('#videoExportFps', node => [...node.options].filter(option => +option.value > 25).every(option => option.hidden && option.disabled)), true);
    await actor.evaluate(() => DublineDropdown.button(document.getElementById('videoExportSource')).click()); assert.equal(await actor.$eval('#dubSelectOptions [aria-disabled=true] small', node => node.textContent), await actor.evaluate(() => t('onlyHost'))); await actor.keyboard.press('Escape'); await actor.evaluate(() => closeFilesModal());
  });
  test('successful actual export has a compact file report and incomplete lines remain permitted', async () => {
    const directory = fs.mkdtempSync(path.join(server.dirs.data, 'reported-export-')); await (await host.createCDPSession()).send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
    await host.evaluate(() => { window.originalExportPrepare = requireExportTake; requireExportTake = async line => { DublineSceneReview.processingError(line, true); throw Error('Temporary audio processing failure #' + line.id); }; openFilesModal(); switchFilesTab('export'); }); await waitFor(host, () => videoExportPanel.dataset.ready === 'true');
    await host.click('#startRenderBtn'); try { await waitFor(host, () => !renderInProgress && document.getElementById('renderStatusText').textContent.includes('#2')); } catch (error) { console.log('Export failure state', await host.evaluate(() => ({ status: renderStatusText.textContent, report: DublineSceneReview.snapshot(), running: renderInProgress, disabled: startRenderBtn.disabled }))); throw error; } assert.equal(await host.$eval('#videoExportResult', node => node.hidden), true); assert.equal(await host.$eval('#renderStatusText', node => node.dataset.state), 'error'); assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.mp4')).length, 0);
    await host.evaluate(() => { requireExportTake = originalExportPrepare; DublineSceneReview.processingError(session.lines.find(line => line.id === 2), true); }); assert.ok(await host.evaluate(() => DublineSceneReview.snapshot().errors.some(issue => issue.key === 'review.processing'))); await host.click('#startRenderBtn'); await waitUntil(() => fs.readdirSync(directory).some(name => name.endsWith('.mp4')), 60000); await waitFor(host, () => !renderInProgress && !document.getElementById('videoExportResult').hidden); assert.ok(await host.$eval('#videoExportResult', node => node.textContent.includes('2'))); await host.evaluate(() => closeFilesModal());
  });
  test('a missing muted take does not block the audible mix or count as an included recording', async () => {
    const url = await host.evaluate(() => session.lines.find(line => line.id === 2).audioUrl), file = path.resolve(server.dirs.uploads, decodeURIComponent(url.slice('/uploads/'.length))); assert.ok(file.startsWith(path.resolve(server.dirs.uploads) + path.sep)); fs.renameSync(file, file + '.muted');
    try { const saved = await host.evaluate(() => new Promise(resolve => socket.emit('project_audio_update', { sessionId: session.activeSessionId, channel: 'dub', field: 'muted', value: true, revision: session.projectAudio.revision }, resolve))); assert.ok(saved.ok);
      await host.evaluate(() => { openFilesModal(); switchFilesTab('export'); }); await waitFor(host, () => videoExportPanel.dataset.ready === 'true'); await host.click('#startRenderBtn'); await waitFor(host, () => !renderInProgress && !document.getElementById('videoExportResult').hidden, 30000); assert.ok(await host.$eval('#videoExportResult', node => node.textContent.includes('· 0 takes'))); await host.evaluate(() => closeFilesModal());
    } finally { fs.renameSync(file + '.muted', file); await host.evaluate(() => new Promise(resolve => socket.emit('project_audio_update', { sessionId: session.activeSessionId, channel: 'dub', field: 'muted', value: false, revision: session.projectAudio.revision }, resolve))); }
  });
  test('review dialog retains footer/focus and translated labels at 150%', async () => {
    await actor.setViewport({ width: 640, height: 850 }); await actor.evaluate(async () => { document.documentElement.dataset.theme = 'light'; await DublineI18n.setLanguage('ru'); document.body.style.zoom = '150%'; sceneReviewBtn.click(); });
    const geometry = await actor.evaluate(() => { const box = sceneReviewDialog.getBoundingClientRect(), button = sceneReviewClose.getBoundingClientRect(); return box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 && button.bottom <= box.bottom; }); assert.ok(geometry); await actor.click('#sceneReviewClose'); await actor.evaluate(() => { document.body.style.zoom = ''; }); await actor.setViewport({ width: 1600, height: 900 });
  });
  test('no unhandled browser errors', () => { assert.deepEqual(host.errors, []); assert.deepEqual(actor.errors, []); });
});
