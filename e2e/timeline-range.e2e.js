const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, waitUntil } = require('./helpers');

describe('Dub Mode private time range and exact fragment export', { skip: skipReason, timeout: 180000 }, () => {
  let server, browser, page, guest;
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    page = await openPlayer(browser, server.url('time-range'), 'Host', { audioExpanded: false }); await loadFixture(page);
    guest = await openPlayer(browser, server.url('time-range'), 'Guest', { audioExpanded: false }); await waitFor(guest, () => session?.loaded);
    await page.evaluate(() => { layout.top = 280; applyLayout(); fitTimeline(); });
    await waitFor(page, () => !sceneMediaPreparation()?.key && video.readyState >= 3);
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  async function drag(start, end, cancel = false, selector = '.track-row[data-character] .track-timeline') {
    await page.$eval(selector, n => n.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    const box = await page.$eval(selector, n => { const b = n.getBoundingClientRect(), scale = b.width / n.offsetWidth || 1; return { x: b.left, y: b.bottom - 4 * scale, p: pxPerSec * scale }; });
    await page.mouse.move(box.x + start * box.p, box.y); await page.mouse.down();
    await page.mouse.move(box.x + end * box.p, box.y, { steps: 8 });
    if (cancel) await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await waitFor(page, () => !transportScrubbing);
  }
  test('left/right drags select time, preserve cues and never select it for another participant', async () => {
    const before = await page.evaluate(() => JSON.stringify(session.lines));
    await drag(1, 2.5);
    const range = await page.evaluate(() => DublineTimelineRange.get());
    assert.ok(Math.abs(range.start - 1) < .04 && Math.abs(range.end - 2.5) < .04, JSON.stringify(range));
    assert.equal(await page.evaluate(() => JSON.stringify(session.lines)), before);
    assert.equal(await guest.evaluate(() => DublineTimelineRange.get()), null);
    await drag(2.5, 1);
    assert.ok(await page.evaluate(() => Math.abs(DublineTimelineRange.get().start - 1) < .04));
    const previous = await page.evaluate(() => DublineTimelineRange.get()); await drag(.3, 2, true);
    assert.deepEqual(await page.evaluate(() => DublineTimelineRange.get()), previous);
  });
  test('ordinary row redraw does not break capture; empty space below roles also selects', async () => {
    const box = await page.$eval('.track-row[data-character] .track-timeline', n => { const b = n.getBoundingClientRect(); return { x: b.left, y: b.bottom - 4, p: pxPerSec }; });
    const lines = await page.evaluate(() => JSON.stringify(session.lines));
    await page.mouse.move(box.x + box.p, box.y); await page.mouse.down(); await page.mouse.move(box.x + 1.5 * box.p, box.y);
    await page.evaluate(() => renderTimeline()); await page.mouse.move(box.x + 2.5 * box.p, box.y, { steps: 5 }); await page.mouse.up();
    const range = await page.evaluate(() => DublineTimelineRange.get()); assert.ok(Math.abs(range.start - 1) < .04 && Math.abs(range.end - 2.5) < .04, JSON.stringify(range));
    const empty = await page.evaluate(() => { const box = timelineContainer.getBoundingClientRect(), row = [...document.querySelectorAll('.track-row')].at(-1).getBoundingClientRect(), ruler = document.querySelector('.ruler-ticks').getBoundingClientRect(); return { x: ruler.left + pxPerSec, y: Math.min(box.bottom - 10, row.bottom + 70) }; });
    await page.mouse.click(empty.x, empty.y, { count: 2 }); assert.deepEqual(await page.evaluate(() => DublineTimelineRange.get()), { start: 0, end: 12 });
    assert.equal(await page.evaluate(() => JSON.stringify(session.lines)), lines);
  });
  test('Space plays from the range and stops at its end; repeat starts again; single click and Escape clear', async () => {
    await page.evaluate(() => { DublineTimelineRange.set(.6, 1.2); video.currentTime = 3; timelineContainer.focus(); });
    await page.keyboard.press('Space'); await waitFor(page, () => !video.paused && video.currentTime < 1.2);
    await waitFor(page, () => video.paused && Math.abs(video.currentTime - 1.2) < .02);
    await page.keyboard.press('Space'); await waitFor(page, () => !video.paused && video.currentTime < 1.2);
    await page.keyboard.press('Space'); await waitFor(page, () => video.paused);
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => DublineTimelineRange.get()), null);
    await page.evaluate(() => DublineTimelineRange.set(1, 2));
    const box = await page.$eval('.ruler-ticks', n => { const b = n.getBoundingClientRect(); return { x: b.x + pxPerSec * 2, y: b.y + 12 }; });
    await page.mouse.click(box.x, box.y); assert.equal(await page.evaluate(() => DublineTimelineRange.get()), null);
  });
  test('edge dragging scrolls, clamps to the real video and leaves cue data unchanged', async () => {
    await page.evaluate(() => { setTimelineZoom(150, labelWidth, 0); timelineContainer.scrollLeft = 0; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const data = await page.evaluate(() => { const box = timelineContainer.getBoundingClientRect(), ruler = document.querySelector('.ruler-ticks').getBoundingClientRect(); return { x: ruler.left + pxPerSec, right: box.right, y: ruler.top + 12, lines: JSON.stringify(session.lines) }; });
    await page.mouse.move(data.x, data.y); await page.mouse.down(); await page.mouse.move(data.right - 2, data.y, { steps: 4 });
    await waitFor(page, () => timelineContainer.scrollLeft >= 200);
    await page.mouse.move(data.right + 2500, data.y); await page.mouse.up();
    assert.equal(await page.evaluate(() => DublineTimelineRange.get().end), 12);
    assert.equal(await page.evaluate(() => JSON.stringify(session.lines)), data.lines);
    await page.evaluate(() => { fitTimeline(); }); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  });
  test('double clicking empty Dub space selects the whole actual video, not the timeline tail', async () => {
    const box = await page.$eval('.track-row[data-character] .track-timeline', n => { const b = n.getBoundingClientRect(); return { x: b.x + pxPerSec, y: b.bottom - 4 }; });
    await page.mouse.click(box.x, box.y, { count: 2 });
    assert.deepEqual(await page.evaluate(() => DublineTimelineRange.get()), { start: 0, end: 12 });
    assert.equal(await page.evaluate(() => session.lines.length), 4);
  });
  test('fractional UI zoom and role width changes keep the selected times and overlay aligned', async () => {
    await page.setViewport({ width: 1920, height: 1080 });
    for (const zoom of [1.25, 1.5]) {
      await page.evaluate(zoom => { document.body.style.zoom = String(zoom); layout.top = 230; applyLayout(); }, zoom);
      await page.focus('.ruler-corner .role-column-handle'); await page.keyboard.press('End');
      await page.evaluate(() => fitTimeline()); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await drag(.75, 2.25);
      const result = await page.evaluate(() => { const range = DublineTimelineRange.get(), overlay = document.querySelector('.timeline-time-range').getBoundingClientRect(), origin = document.querySelector('.track-timeline').getBoundingClientRect(), scale = origin.width / document.querySelector('.track-timeline').offsetWidth; return { range, difference: overlay.left - origin.left - range.start * pxPerSec * scale }; });
      assert.ok(Math.abs(result.range.start - .75) < .04 && Math.abs(result.range.end - 2.25) < .04, JSON.stringify(result));
      assert.ok(Math.abs(result.difference) < 1, JSON.stringify(result));
    }
    await page.evaluate(() => { document.body.style.zoom = ''; });
    await page.focus('.ruler-corner .role-column-handle'); await page.keyboard.press('Home');
  });
  test('Edit Mode keeps empty-space scrubbing and double-click line creation, with no time selection', async () => {
    await page.evaluate(() => { document.body.style.zoom = ''; timelineContainer.scrollLeft = 0; });
    await page.evaluate(() => setStudioMode('edit')); await waitFor(page, () => session.mode === 'edit');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
    assert.equal(await page.evaluate(() => DublineTimelineRange.get()), null);
    await drag(1, 2);
    const current = await page.evaluate(() => video.currentTime); assert.ok(Math.abs(current - 2) < .04, String(current));
    assert.equal(await page.evaluate(() => DublineTimelineRange.get()), null);
    const before = await page.evaluate(() => session.lines.length);
    const box = await page.$eval('.track-row[data-character="Friend"] .track-timeline', n => { const b = n.getBoundingClientRect(); return { x: b.x + pxPerSec, y: b.bottom - 4 }; });
    await page.mouse.click(box.x, box.y, { count: 2 }); await waitFor(page, count => session.lines.length === count + 1, 10000, before);
    await page.evaluate(() => setStudioMode('dub')); await waitFor(page, () => session.mode === 'dub');
  });
  test('selected audio is an exact slice of the full mix across an eight-second window boundary', async () => {
    const result = await page.evaluate(async () => {
      const mb = await import('/vendor/mediabunny/mediabunny.min.mjs'), snapshot = createExportSnapshot();
      const voice = new AudioBuffer({ sampleRate: 48000, length: 48000 * 4, numberOfChannels: 1 });
      for (let i = 0; i < voice.length; i++) voice.getChannelData(0)[i] = .1 * Math.sin(i * 2 * Math.PI * 370 / 48000);
      const voiceUrl = URL.createObjectURL(new Blob([audioBufferToWav(voice)], { type: 'audio/wav' }));
      snapshot.takes = [{ ...snapshot.scene.lines[0], audioUrl: voiceUrl, trimEnabled: true, trimStart: .2, trimEnd: 3.5, effect: 'telephone', effectAmount: .6, pitch: 2, pitchMode: 'override' }];
      const take = snapshot.takes[0]; take.audioStart = 6.9; take.pan = -.4; take.volume = .7;
      delete take._exportVoice; take._exportVoice = DublineVoiceChain.resolve(take, snapshot.scene);
      snapshot.gains.original = 0; snapshot.gains.backing = .7;
      snapshot.gains.mix.autoDuckEnabled = true; snapshot.gains.mix.autoDuckAmount = .5;
      snapshot.gains.mix.backing.offset = .125;
      const all = []; for await (const chunk of DublineVideoExportAudio.chunks(mb, snapshot, 12, () => {}, () => {})) all.push(chunk.buffer);
      const reference = [new Float32Array(12 * 48000), new Float32Array(12 * 48000)]; let offset = 0;
      for (const block of all) { for (let c = 0; c < 2; c++) reference[c].set(block.getChannelData(c), offset); offset += block.length; }
      snapshot.exportRange = { start: 7.137, end: 9.579 }; let maximum = 0, count = 0, end;
      for await (const chunk of DublineVideoExportAudio.chunks(mb, snapshot, 12, () => {}, () => {})) {
        for (let c = 0; c < 2; c++) { const data = chunk.buffer.getChannelData(c); for (let i = 0; i < data.length; i++) maximum = Math.max(maximum, Math.abs(data[i] - reference[c][Math.round(7.137 * 48000) + count + i])); }
        count += chunk.buffer.length; end = chunk.end;
      }
      URL.revokeObjectURL(voiceUrl); return { maximum, count, end };
    });
    assert.equal(result.count, Math.round(2.442 * 48000)); assert.ok(result.maximum < 1e-7, JSON.stringify(result)); assert.ok(Math.abs(result.end - 2.442) < 1e-8);
  });
  async function download(target, mode) {
    const directory = fs.mkdtempSync(path.join(server.dirs.data, 'range-export-'));
    await (await target.createCDPSession()).send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
    await target.evaluate(async mode => { DublineTimelineRange.set(2.137, 6.579); openFilesModal(); switchFilesTab('export'); await DublineVideoExportPanel.open(); document.querySelector(`[name=videoExportMode][value=${mode}]`).click(); }, mode);
    await waitFor(target, () => videoExportPanel.dataset.ready === 'true' && !startRenderBtn.disabled);
    await target.click('#startRenderBtn'); await waitFor(target, () => ['success','error'].includes(renderStatusText.dataset.state), 60000);
    assert.equal(await target.$eval('#renderStatusText', n => n.dataset.state), 'success', await target.$eval('#renderStatusText', n => n.textContent));
    await waitUntil(() => fs.readdirSync(directory).some(n => n.endsWith('.mp4')) && !fs.readdirSync(directory).some(n => n.endsWith('.crdownload')), 10000);
    const file = path.join(directory, fs.readdirSync(directory).find(n => n.endsWith('.mp4')));
    const mb = await import('mediabunny'), input = new mb.Input({ source: new mb.FilePathSource(file), formats: mb.ALL_FORMATS });
    try {
      const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
      assert.ok(Math.abs(await video.computeDuration() - 4.442) < .045); assert.ok(Math.abs(await audio.computeDuration() - 4.442) < .055);
      assert.ok(Math.abs((await new mb.EncodedPacketSink(video).getFirstPacket()).timestamp) < .001);
    } finally { input.dispose(); }
    const decode = spawnSync(require('ffmpeg-static'), ['-v','error','-i',file,'-f','null','-'], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(decode.status, 0, decode.stderr); assert.equal(decode.stderr, '');
    await target.evaluate(() => closeFilesModal()); return file;
  }
  test('guest fast export re-encodes only the selected fragment with timestamps starting at zero', async () => { await download(guest, 'fast'); });
  test('host original-source export cuts the same exact fragment through the existing server path', async () => { await download(page, 'original'); });
  test('server rejects malformed, out-of-source and packet-copy range requests', async () => {
    const responses = await page.evaluate(async () => {
      const results = [];
      for (const range of ['invalid', JSON.stringify({ start: -1, end: 4 }), JSON.stringify({ start: 0, end: 13 }), JSON.stringify({ start: 2, end: 4 })]) {
        const form = new FormData(); form.append('clientId', clientId); form.append('sessionId', session.activeSessionId); form.append('videoUrl', session.videoUrl); form.append('source', 'original'); form.append('range', range);
        form.append('soundtrack', new Blob([audioBufferToWav(new AudioBuffer({ sampleRate: 48000, length: 48000, numberOfChannels: 2 }))], { type: 'audio/wav' }), 'audio.wav');
        const response = await fetch('/api/export-original-video?room=' + currentRoom, { method: 'POST', body: form }); results.push({ status: response.status, key: (await response.json()).key });
      }
      return results;
    });
    for (const result of responses) assert.deepEqual(result, { status: 400, key: 'range.invalid' });
  });
  test('all-video export remains explicit; mode change clears range and no project property is serialized', async () => {
    await page.evaluate(async () => { openFilesModal(); switchFilesTab('export'); await DublineVideoExportPanel.open(); videoExportScope.value = 'all'; videoExportScope.dispatchEvent(new Event('change')); });
    assert.equal(await page.evaluate(() => DublineVideoExportPanel.settings().range), null);
    assert.equal(await page.evaluate(() => Object.keys(session).some(k => /exportRange|timelineRange/.test(k))), false);
    assert.deepEqual(page.errors, []); assert.deepEqual(guest.errors, []);
  });
});
