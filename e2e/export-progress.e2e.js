const { describe, test, before, after } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor } = require('./helpers');
describe('export progress and bounded preparation', { skip: skipReason, timeout: 240000 }, () => {
  let server, browser, host, guest;
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port); host = await openPlayer(browser, server.url('export-progress'), 'Host'); await loadFixture(host);
    guest = await openPlayer(browser, server.url('export-progress'), 'Guest'); await waitFor(guest, () => session.loaded); await claimAndSelect(host, 1);
    await host.evaluate(async () => { const b = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 }); for (let i = 0; i < b.length; i++) b.getChannelData(0)[i] = .08 * Math.sin(i * .1); await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: 1, nick: myName, audioStart: 0, trimStart: .1, trimEnd: .9, duration: 1, blob: new Blob([audioBufferToWav(b)], { type: 'audio/wav' }), createdAt: Date.now() }); });
    await (await host.createCDPSession()).send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: fs.mkdtempSync(path.join(server.dirs.data, 'progress-export-')) });
    await host.evaluate(() => { openFilesModal(); switchFilesTab('export'); }); await waitFor(host, () => videoExportPanel.dataset.ready === 'true');
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('real work counters, quiet warning and final completion remain distinct from a ticking interface', async () => {
    await host.evaluate(() => {
      window.qaPrepare = requireExportTake; window.qaCreate = DublineExportProgress.create; window.qaOffset = 0;
      DublineExportProgress.create = () => qaCreate(() => performance.now() + qaOffset);
      requireExportTake = async (...args) => { const result = await qaPrepare(...args); if (!window.qaPassed) { qaPassed = true; await new Promise(resolve => { window.qaRelease = resolve; }); } return result; };
      void startVideoRender();
    });
    try {
      await waitFor(host, () => !!window.qaRelease && !!document.querySelector('[data-phase=takes]'));
      assert.match(await host.$eval('[data-phase=takes] strong', n => n.textContent), /0 \/ 1/);
      const previous = await host.$eval('[data-phase=video] strong', n => n.textContent);
      await host.evaluate(() => { socket.listeners('video_export_progress')[0]({ progressId: 'unrelated-export', sessionId: session.activeSessionId, current: 9000, total: 9000 }); qaOffset = 20000; });
      await waitFor(host, () => renderProgressActivity.dataset.waiting === 'true'); assert.equal(await host.$eval('[data-phase=video] strong', n => n.textContent), previous);
      assert.equal(await host.$eval('#cancelVideoExportBtn', n => n.hidden), false);
      await host.evaluate(() => qaRelease()); await waitFor(host, () => !renderInProgress, 20000);
      assert.equal(await host.$eval('#renderStatusText', n => n.dataset.state), 'success'); assert.equal(await host.$eval('#renderProgressActivity', n => n.dataset.waiting), 'false');
      for (const phase of ['takes', 'audio', 'video', 'saving']) assert.equal(await host.$eval('[data-phase=' + phase + ']', n => n.dataset.state), 'done');
      assert.equal(await host.$eval('#renderProgressBar', n => n.style.width), '100%');
    } finally { await host.evaluate(() => { requireExportTake = qaPrepare; DublineExportProgress.create = qaCreate; }); }
  });
  test('cancellation during the initial file check stops cleanly before rendering starts', async () => {
    await host.evaluate(() => {
      window.qaReview = DublineSceneReview.checkFiles;
      DublineSceneReview.checkFiles = ({ signal }) => new Promise((_, reject) => { window.qaChecking = true; signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }); });
      void startVideoRender();
    });
    await waitFor(host, () => window.qaChecking && !cancelVideoExportBtn.hidden); assert.equal(await host.evaluate(() => renderInProgress), false);
    await host.click('#cancelVideoExportBtn'); await waitFor(host, () => renderStatusText.dataset.state === 'cancelled' && cancelVideoExportBtn.hidden);
    assert.equal(await host.$eval('[data-phase=checking]', n => n.dataset.state), 'stopped'); assert.equal(await host.$eval('[data-phase=checking] progress', n => n.hasAttribute('value')), true);
    await host.evaluate(() => { DublineSceneReview.checkFiles = qaReview; });
  });
  test('server copy progress reaches only the authenticated exporting actor and carries the exact request identity', async () => {
    await guest.evaluate(() => { window.qaForeignProgress = []; socket.on('video_export_progress', value => qaForeignProgress.push(value)); });
    const result = await host.evaluate(async () => {
      const events = [], listen = data => events.push(data); socket.on('video_export_progress', listen);
      const snapshot = createExportSnapshot(), job = { id: 'private-progress-test', abort: new AbortController(), check: () => assertExportScene(snapshot), report: () => {} };
      try { const chosen = { ...DublineVideoExportPanel.settings(), mode: 'original', source: 'original' }, result = await renderOriginalVideo(() => {}, snapshot, chosen, job); const response = await fetch(result.downloadUrl); if (!response.ok) throw Error(await readError(response)); await response.arrayBuffer(); return { events, scene: snapshot.scene.activeSessionId }; }
      finally { socket.off('video_export_progress', listen); }
    });
    assert.ok(result.events.length > 0); assert.ok(result.events.every(event => event.progressId === 'private-progress-test' && event.sessionId === result.scene && event.current >= 0 && event.current <= event.total)); assert.equal(result.events.at(-1).done, true);
    assert.deepEqual(await guest.evaluate(() => qaForeignProgress), []);
  });
  test('two-job preparation preserves exact processed audio and measures cold sequential/parallel throughput', async () => {
    const result = await host.evaluate(async () => {
      const results = [];
      for (const noise of [false, true]) for (let run = 0; run < 3; run++) for (const concurrency of run % 2 ? [2, 1] : [1, 2]) {
        const b = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 }); for (let i = 0; i < b.length; i++) b.getChannelData(0)[i] = .08 * Math.sin(i * .1);
        const blob = new Blob([audioBufferToWav(b)], { type: 'audio/wav' }), urls = Array.from({ length: 24 }, () => URL.createObjectURL(blob));
        try {
          const snapshot = createExportSnapshot(); snapshot.takes = urls.map((audioUrl, id) => { const line = { ...snapshot.scene.lines[0], id: id + 100, audioUrl, effect: id % 2 ? 'radio' : 'cave', pitch: id % 5 - 2, pitchMode: 'override', audioStart: id / 2, _exportNoise: { enabled: noise, strength: .6 }, _exportLevel: false }; delete line._exportVoice; line._exportVoice = DublineVoiceChain.resolve(line, snapshot.scene); return line; });
          const begin = performance.now(), prepared = await DublineVideoExportAudio.prepare(snapshot, 20, () => {}, () => assertExportScene(snapshot), { concurrency }), ms = performance.now() - begin;
          const hashes = []; for (const take of prepared.takes) { const buffer = await requireExportTake(take.line); const hash = await crypto.subtle.digest('SHA-256', buffer.getChannelData(0)); hashes.push(Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('')); }
          results.push({ noise, run, concurrency, ms, hashes });
        } finally { for (const url of urls) { audio.invalidateSource(url); URL.revokeObjectURL(url); } }
      }
      return results;
    });
    for (const noise of [false, true]) {
      const cases = result.filter(r => r.noise === noise); for (const item of cases) assert.deepEqual(item.hashes, cases[0].hashes);
      const median = concurrency => cases.filter(r => r.concurrency === concurrency).map(r => r.ms).sort((a, b) => a - b)[1]; console.log('24 cold recordings:', JSON.stringify({ rnnoise: noise, sequentialMs: median(1), parallelMs: median(2) }));
    }
    fs.mkdirSync(path.resolve('audit'), { recursive: true }); fs.writeFileSync(path.resolve('audit/export-progress-benchmark.json'), JSON.stringify(result.map(({ hashes, ...metrics }) => metrics), null, 2));
  });
  test('no unhandled errors', () => { assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []); });
});
