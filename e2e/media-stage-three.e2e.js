const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, wait } = require('./helpers');

describe('Media sources and uninterrupted host playback', { skip: skipReason }, () => {
  let server, browser, host;
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url('media-stage-three'), 'Host'); await loadFixture(host);
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  async function heldDownload() {
    return openPlayer(browser, server.url('media-stage-three', 'dubline.test'), 'Guest', {
      p2pConsent: 'accepted', beforeLoad: page => page.evaluateOnNewDocument(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const original = downloadFile;
          window.__downloadCalls = 0;
          downloadFile = async (file, progress, abort) => {
            __downloadCalls++;
            if (file.role === 'video') await new Promise(resolve => setTimeout(resolve, 1100));
            const result = await original(file, progress, abort);
            if (file.role === 'video') await new Promise((resolve, reject) => {
              window.__downloadReady = true; window.__finishDownload = resolve;
              abort.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
            });
            return result;
          };
        }, { once: true });
      })
    });
  }
  test('watching from the host keeps the verified download and progress, and completion never reloads playback', async () => {
    const guest = await heldDownload();
    try {
      await waitFor(guest, () => window.__downloadReady && p2pStatus?.state === 'fetching' && document.querySelector('#p2pStatusText button'));
      await guest.evaluate(() => { window.__heldJob = mediaDownload; window.__heldProgress = JSON.stringify(p2pStatus); });
      await guest.click('#p2pStatusText button');
      assert.equal(await guest.evaluate(() => mediaDownload === __heldJob && !__heldJob.abort.signal.aborted), true);
      assert.equal(await guest.evaluate(() => JSON.stringify(p2pStatus) === __heldProgress), true);
      await waitFor(guest, () => video.readyState >= 3);
      await guest.evaluate(async () => {
        video.currentTime = 3; await video.play();
        window.__source = video.getAttribute('src'); window.__reloads = 0;
        video.addEventListener('loadstart', () => __reloads++);
        __finishDownload();
      });
      await waitFor(guest, () => !mediaDownload && localMedia?.videoBlob && p2pStatus?.state === 'done');
      await wait(300);
      const result = await guest.evaluate(() => ({ reloads: __reloads, paused: video.paused, time: video.currentTime,
        source: video.getAttribute('src'), wanted: __source, cached: localMedia.videoBlob.size, calls: __downloadCalls,
        mapped: mediaUrl(session.videoUrl), hash: session.videoHash }));
      assert.equal(result.reloads, 0); assert.equal(result.paused, false); assert.ok(result.time >= 3);
      assert.equal(result.source, result.wanted); assert.equal(result.mapped, result.source);
      assert.ok(result.cached > 0 && result.hash); assert.equal(result.calls, 2, 'one job for each existing video/background asset');
      assert.deepEqual(guest.errors, []);
    } finally { await guest.browserContext().close(); }
  });
  test('a scene change cancels the watched download and its late completion cannot replace the new scene', async () => {
    const guest = await heldDownload();
    try {
      await waitFor(guest, () => window.__downloadReady);
      await guest.evaluate(() => { window.__oldJob = mediaDownload; watchFromHostNow(); });
      const oldId = await guest.evaluate(() => session.activeSessionId);
      await loadFixture(host);
      await waitFor(guest, id => session.activeSessionId !== id && __oldJob.abort.signal.aborted, 10000, oldId);
      assert.equal(await guest.evaluate(() => mediaDownload === __oldJob), false);
      assert.deepEqual(guest.errors, []);
    } finally { await guest.browserContext().close(); }
  });
  test('background controls update guests and retain lines/takes; without a separate source there is one Background row', async () => {
    await loadFixture(host);
    const guest = await openPlayer(browser, server.url('media-stage-three', 'dubline.test'), 'Audio guest');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-backing-ui-'));
    try {
      await waitFor(host, () => session.audioTracks?.length && !session.audioTracksPending);
      await waitFor(guest, () => session?.loaded && document.querySelector('#backingUploadBtn'));
      await waitFor(guest, () => localMedia?.videoBlob && !mediaDownload && video.readyState >= 3);
      await guest.evaluate(async () => {
        video.currentTime = 2; await video.play(); window.__audioUpdateReloads = 0;
        video.addEventListener('loadstart', () => __audioUpdateReloads++);
      });
      assert.equal(await guest.$eval('#backingUploadBtn', button => button.disabled), true);
      const before = await host.evaluate(() => ({ id: session.activeSessionId, lines: JSON.stringify(session.lines) }));
      const bytes = Buffer.from(await host.evaluate(async () => [...new Uint8Array(await (await fetch(session.backingUrl)).arrayBuffer())]));
      const filename = path.join(dir, 'New background.wav'); fs.writeFileSync(filename, bytes);
      await host.click('#backingRemoveBtn');
      await waitFor(host, () => !session.backingUrl && !session.baseBackingUrl);
      await waitFor(guest, () => !session.backingUrl && document.querySelectorAll('.studio-audio-row').length === 2);
      const rowState = await guest.evaluate(() => ({ names: [...document.querySelectorAll('.studio-channel-head b')].map(node => node.textContent),
        gains: readRenderGains(), heard: studioPlaybackVolumes(), source: DublineProjectAudio.sources(session), lines: JSON.stringify(session.lines) }));
      assert.deepEqual(rowState.names, ['Background / M&E', 'Dub']); assert.equal(rowState.source.backing, '');
      assert.equal(rowState.gains.original, rowState.heard.original); assert.equal(rowState.gains.backing, 0); assert.equal(rowState.lines, before.lines);
      await (await host.$('#backingSourceInput')).uploadFile(filename);
      await waitFor(host, () => session.audioMetadata?.backing?.name === 'New background.wav');
      await waitFor(guest, () => session.audioMetadata?.backing?.name === 'New background.wav' && document.querySelectorAll('.studio-audio-row').length === 3);
      await waitFor(guest, () => localMedia?.backingSourceUrl === session.backingUrl && localMedia.backingBlob?.type === 'audio/mp4' && backing.readyState >= 3);
      assert.equal(await guest.evaluate(() => peers.size), 0, 'declined guest uses verified HTTP fallback for the new background');
      assert.deepEqual(await guest.evaluate(() => ({ reloads: __audioUpdateReloads, playing: !video.paused, progressed: video.currentTime >= 2 })), { reloads: 0, playing: true, progressed: true });
      assert.equal(await host.evaluate(() => session.activeSessionId), before.id);
      assert.equal(await host.evaluate(() => JSON.stringify(session.lines)), before.lines);
      assert.deepEqual(await host.$$eval('.studio-channel-head b', nodes => nodes.map(node => node.textContent)), ['Original', 'Background / M&E', 'Dub']);
      assert.match(await host.$eval('#backingSourceName', node => node.textContent), /New background.wav/);
      for (const language of ['en', 'ru', 'uk']) {
        await host.evaluate(language => DublineI18n.setLanguage(language), language);
        for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) {
          await host.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          const labels = await host.evaluate(() => ['backing.add', 'backing.current', 'backing.changed'].map(key => t(key)));
          for (const label of labels) assert.doesNotMatch(label, /^backing\./);
          assert.equal(await host.$eval('#backingUploadBtn', node => getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0), true);
        }
      }
      await host.evaluate(() => DublineI18n.setLanguage('en'));
      assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []);
    } finally { await guest.browserContext().close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('zoom preserves waveform canvases and keyboard focus, painting once per channel at the final scroll position', async () => {
    await loadFixture(host);
    await waitFor(host, () => [...document.querySelectorAll('.studio-audio-row canvas')].every(canvas => canvas.dataset.waveRender) && [...document.querySelectorAll('.studio-wave-status')].every(node => !/loading/i.test(node.textContent)));
    await host.focus('#volOriginal');
    await host.evaluate(() => { window.__audioCanvases = [...document.querySelectorAll('.studio-audio-row canvas')]; window.__focusedAudio = document.activeElement; });
    for (const zoom of [40, 70, 90, 55]) {
      await host.evaluate(zoom => setTimelineZoom(zoom), zoom);
      await waitFor(host, zoom => pxPerSec === zoom && document.querySelector('.studio-wave-area').style.width === `${(timelineSeconds() + TIMELINE_TAIL) * zoom}px`, 5000, zoom);
      const result = await host.evaluate(() => ({ kept: __audioCanvases.every(canvas => canvas.isConnected), focused: document.activeElement === __focusedAudio,
        width: timeline.querySelector('.studio-audio-sources').getBoundingClientRect().width, viewport: timelineContainer.clientWidth }));
      assert.equal(result.kept, true); assert.equal(result.focused, true); assert.ok(Math.abs(result.width - result.viewport) <= 1);
    }
    const paints = await host.evaluate(() => {
      const before = __audioCanvases.map(canvas => Number(canvas.dataset.waveRender));
      timelineContainer.scrollLeft = 220; setTimelineZoom(80); cancelAnimationFrame(zoomFrame); renderTimeline();
      return __audioCanvases.map((canvas, i) => Number(canvas.dataset.waveRender) - before[i]);
    });
    assert.deepEqual(paints, [1, 1, 1]);
    await host.click('[data-studio-action="audio"]');
    assert.equal(await host.$eval('.studio-audio-sources', node => getComputedStyle(node).display), 'none');
    await host.click('[data-studio-action="audio"]');
    assert.equal(await host.$$eval('.studio-audio-row', nodes => nodes.length), 3);
    assert.deepEqual(host.errors, []);
  });
  test('an incompatible AVC profile imports as a playable working copy while the original remains protected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-codec-browser-')), filename = path.join(dir, 'High10.mp4');
    try {
      const ff = require('node:child_process').spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', filename], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      assert.equal(ff.status, 0, ff.stderr);
      const old = await host.evaluate(() => session.activeSessionId);
      await host.evaluate(() => { openFilesModal(); switchFilesTab('video'); });
      await (await host.$('#customVideoInput')).uploadFile(filename); await host.click('#customUploadBtn');
      await waitFor(host, id => session.activeSessionId !== id && session.hasOriginalVideo && video.readyState >= 3 && !video.error, 20000, old);
      await host.evaluate(() => closeFilesModal());
      await host.evaluate(async () => { video.currentTime = .1; await video.play(); });
      await waitFor(host, () => video.currentTime > .5 && !video.error);
      const info = await host.evaluate(async () => (await fetch(`/api/video-diagnostics?${new URLSearchParams({ room: currentRoom, sessionId: session.activeSessionId, clientId })}`)).json());
      assert.equal(info.codec, 'h264'); assert.equal(info.pixelFormat, 'yuv420p'); assert.equal(info.requiresCompatibilityCopy, false); assert.equal(info.workingCopy, true);
      assert.deepEqual(host.errors, []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
