const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipReason, launchBrowser, startServer, openPlayer, loadFixture, claimAndSelect, waitFor, wait } = require('./helpers');

describe('Studio failure recovery', { skip: skipReason }, () => {
  let server, browser, page, index = 0;
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); });
  after(async () => { if (browser) await browser.close(); if (server) await server.cleanup(); });
  beforeEach(async () => { page = await openPlayer(browser, server.url(`reliability-${++index}`), 'Alice'); });
  afterEach(async () => { if (page) await page.browserContext().close(); });

  for (const codec of ['alac', 'ac3', 'aac', null]) {
    test(`single-track ${codec || 'silent'} video preserves its soundtrack in export`, async () => {
      const file = path.join(server.dirs.data, `source-${codec || 'silent'}.mp4`);
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=1'];
      if (codec) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1');
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(codec ? ['-c:a', codec, '-shortest'] : ['-an']), file);
      const generated = spawnSync(require('ffmpeg-static'), args);
      assert.equal(generated.status, 0, String(generated.stderr));
      const status = await page.evaluate(async base64 => {
        const data = new FormData(); data.append('clientId', clientId);
        data.append('video', new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'video/mp4' }), 'source.mp4');
        return (await fetch(`/api/upload-custom?room=${encodeURIComponent(currentRoom)}`, { method: 'POST', body: data })).status;
      }, fs.readFileSync(file).toString('base64'));
      assert.equal(status, 200);
      await waitFor(page, () => session.loaded && typeof session.videoHasAudio === 'boolean' && video.readyState >= 2);
      const result = await page.evaluate(async () => {
        session.projectAudio.original.volume = 1;
        const source = DublineProjectAudio.sources(session).original;
        const rendered = await mixSoundtrack(1, readRenderGains(), () => {});
        let peak = 0; for (const value of rendered.getChannelData(0)) peak = Math.max(peak, Math.abs(value));
        return { source, videoUrl: session.videoUrl, hasAudio: session.videoHasAudio, tracks: session.audioTracks.length, peak,
          caption: document.querySelector('[data-audio-channel=original] .studio-wave-source').textContent };
      });
      assert.equal(result.hasAudio, !!codec); assert.equal(result.tracks, codec ? 1 : 0);
      assert.equal(result.caption, codec ? 'Audio from video' : '');
      if (codec) assert.ok(result.peak > 0.05, JSON.stringify(result));
      else { assert.equal(result.source, ''); assert.equal(result.peak, 0); }
      if (codec === 'aac') assert.equal(result.source, result.videoUrl);
      if (codec === 'alac' || codec === 'ac3') assert.ok(result.source.endsWith('/track_0.m4a'), result.source);
      if (codec === 'alac') {
        // Emulate a scene saved by the old build: [] meant both unchecked and silent.
        const roomId = await page.evaluate(() => currentRoom);
        await wait(1300); await server.stop();
        const roomsFile = path.join(server.dirs.data, 'rooms.json');
        const rooms = JSON.parse(fs.readFileSync(roomsFile, 'utf8')), room = rooms[roomId];
        for (const target of [room, room.sessions[room.activeSessionId]]) {
          target.audioTracks = []; delete target.videoHasAudio;
        }
        fs.writeFileSync(roomsFile, JSON.stringify(rooms));
        await server.start();
        await waitFor(page, () => socket.connected && session.videoHasAudio === true && session.audioTracks.length === 1);
        assert.equal(await page.evaluate(() => DublineProjectAudio.sources(session).original), result.source);
        await server.restart();
        await waitFor(page, () => socket.connected && session.videoHasAudio === true);
        assert.equal(await page.evaluate(() => DublineProjectAudio.sources(session).original), result.source);
      }
    });
  }

  test('a delayed discarded recorder cannot stop or contaminate the next recording', async () => {
    await loadFixture(page); await claimAndSelect(page, 1);
    await page.evaluate(() => handleStudioRecord(1)); await wait(350);
    await page.evaluate(() => {
      window.previousMic = micStream;
      window.previousDataHandler = mediaRecorder.ondataavailable;
      const stopped = mediaRecorder.onstop;
      mediaRecorder.onstop = event => setTimeout(async () => { await stopped(event); window.previousStopped = true; }, 600);
      finishRecording({ discard: true });
    });
    assert.equal(await page.evaluate(() => previousMic.getTracks().every(track => track.readyState === 'ended')), true);
    await claimAndSelect(page, 2);
    await page.evaluate(async () => {
      await handleStudioRecord(2);
      window.nextMic = micStream;
      previousDataHandler({ data: new Blob(['not part of the next take'], { type: 'audit/sentinel' }) });
    });
    await waitFor(page, () => window.previousStopped);
    const state = await page.evaluate(() => ({
      live: nextMic.getTracks().every(track => track.readyState === 'live'),
      ownsMic: micStream === nextMic, line: recordingLineId,
      contaminated: audioChunks.some(chunk => chunk.type === 'audit/sentinel'), savedOld: !!session.lines[0].audioUrl
    }));
    assert.deepEqual(state, { live: true, ownsMic: true, line: 2, contaminated: false, savedOld: false });
    await page.evaluate(() => finishRecording({ discard: true }));
  });

  test('a delayed saved recorder uploads its own take without affecting a newer take', async () => {
    await loadFixture(page); await claimAndSelect(page, 1);
    await page.evaluate(() => handleStudioRecord(1)); await wait(400);
    await page.evaluate(() => {
      const stopped = mediaRecorder.onstop;
      mediaRecorder.onstop = event => setTimeout(() => stopped(event), 600);
      finishRecording();
    });
    await claimAndSelect(page, 2); await page.evaluate(() => handleStudioRecord(2));
    await waitFor(page, () => !!session.lines[0].audioUrl);
    assert.equal(await page.evaluate(() => recordingLineId === 2 && micStream.getTracks().every(track => track.readyState === 'live')), true);
    assert.equal(await page.evaluate(() => !!session.lines[1].audioUrl), false);
    await wait(200); await page.evaluate(() => finishRecording());
    await waitFor(page, () => !!session.lines[1].audioUrl);
    assert.equal(await page.evaluate(() => session.lines[0].audioUrl !== session.lines[1].audioUrl), true);
  });

  test('microphone permission granted after export starts is released without recording', async () => {
    await loadFixture(page); await claimAndSelect(page, 1);
    const result = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let release;
      navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { release = resolve; });
      const task = handleStudioRecord(1); renderInProgress = true; release(stream); await task;
      const result = { state: recordState, released: stream.getTracks().every(track => track.readyState === 'ended'), recorderStarted: !!mediaRecorder };
      renderInProgress = false; return result;
    });
    assert.deepEqual(result, { state: 'idle', released: true, recorderStarted: false });
  });

  test('recording and video export reject overlapping starts, including the R shortcut', async () => {
    await loadFixture(page); await claimAndSelect(page, 1);
    await page.evaluate(() => {
      window.micRequests = 0; window.realGetMic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...args) => { micRequests++; return realGetMic(...args); };
      renderInProgress = true; showInspector(selectedLine); document.activeElement.blur();
    });
    await page.keyboard.press('r'); await page.evaluate(() => handleStudioRecord(1));
    assert.deepEqual(await page.evaluate(() => ({ requests: micRequests, state: recordState, disabled: document.getElementById('recBtn').disabled })),
      { requests: 0, state: 'idle', disabled: true });
    await page.evaluate(async () => { renderInProgress = false; await handleStudioRecord(1); await startVideoRender(); });
    assert.deepEqual(await page.evaluate(() => ({ rendering: renderInProgress, state: recordState, disabled: document.getElementById('startRenderBtn').disabled })),
      { rendering: false, state: 'preparing', disabled: true });
    await page.evaluate(() => finishRecording({ discard: true }));
  });

  test('a pending playback promise times out and releases real-time export resources', async () => {
    await loadFixture(page); await waitFor(page, () => video.readyState >= 3);
    await page.evaluate(() => {
      const Recorder = window.MediaRecorder, Context = window.AudioContext;
      window.MediaRecorder = class extends Recorder { constructor(...args) { super(...args); window.exportRecorder = this; window.exportStream = args[0]; } };
      window.AudioContext = class extends Context { constructor(...args) { super(...args); window.exportContext = this; } };
      video.play = () => new Promise(() => {}); renderInProgress = true;
      renderRealtime(() => {}, createExportSnapshot()).catch(error => { window.exportFailure = error.code; }).finally(() => { renderInProgress = false; });
    });
    await waitFor(page, () => !!window.exportFailure, 12000);
    await waitFor(page, () => exportContext.state === 'closed' && !renderInProgress);
    assert.deepEqual(await page.evaluate(() => ({ code: exportFailure, state: exportRecorder.state, released: exportStream.getTracks().every(track => track.readyState === 'ended'), paused: video.paused })),
      { code: 'DUBLINE_EXPORT_PLAYBACK', state: 'inactive', released: true, paused: true });
  });

  test('rapid mute and solo clicks preserve the latest intent before acknowledgements', async () => {
    await loadFixture(page);
    for (const field of ['muted', 'solo']) for (const clicks of [2, 3, 4]) {
      await page.evaluate(field => updateProjectAudio('original', field, false), field);
      await waitFor(page, field => session.projectAudio.original[field] === false, 5000, field); await wait(150);
      const revision = await page.evaluate(() => session.projectAudio.revision);
      const optimistic = await page.evaluate(({ field, clicks }) => {
        const button = document.querySelector(`[data-audio-channel=original] [data-audio-field=${field}]`);
        for (let i = 0; i < clicks; i++) button.click();
        return button.getAttribute('aria-pressed');
      }, { field, clicks });
      assert.equal(optimistic, String(clicks % 2 === 1));
      await waitFor(page, ({ revision, field, clicks }) => session.projectAudio.revision >= revision + 2 && session.projectAudio.original[field] === (clicks % 2 === 1), 5000, { revision, field, clicks });
      assert.equal(await page.$eval(`[data-audio-channel=original] [data-audio-field=${field}]`, button => button.getAttribute('aria-pressed')), String(clicks % 2 === 1));
    }
  });

  test('a transient waveform failure retries automatically after the network recovers', async () => {
    let failures = 0;
    const failed = new Set();
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().includes('/api/audio-waveform?')) {
        const channel = new URL(request.url()).searchParams.get('channel');
        if (!failed.has(channel)) { failed.add(channel); failures++; return request.respond({ status: 503, contentType: 'application/json', body: '{}' }); }
      }
      request.continue();
    });
    await loadFixture(page);
    await waitFor(page, () => [...document.querySelectorAll('.studio-audio-row:not([data-audio-channel=dub]) .studio-wave-status')].every(el => el.textContent === ''), 10000);
    assert.equal(failures, 2);
  });

  test('permanent no-audio responses do not cause an endless retry loop', async () => {
    let requests = 0;
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().includes('/api/audio-waveform?')) { requests++; return request.respond({ status: 422, contentType: 'application/json', body: '{}' }); }
      request.continue();
    });
    await loadFixture(page); await wait(2500);
    assert.equal(requests, 2);
    assert.equal(await page.$$eval('.studio-wave-status', els => els.filter(el => el.textContent === 'No readable audio waveform').length), 2);
  });

  test('gain updates do not seek playing sources; millisecond offset changes still do', async () => {
    await loadFixture(page); await waitFor(page, () => video.readyState >= 3 && backing.readyState >= 3 && originalTrackAudio.readyState >= 3);
    await page.evaluate(async () => { ensurePlayCtx(); video.currentTime = 1; await video.play(); }); await wait(600);
    await page.evaluate(() => {
      window.sourceSeeks = [];
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { ...descriptor, set(value) { if (this === backing || this === originalTrackAudio) sourceSeeks.push({ source: this.id, time: value }); descriptor.set.call(this, value); } });
      updateProjectAudio('backing', 'volume', 0.7);
    });
    await waitFor(page, () => session.projectAudio.backing.volume === 0.7); await wait(150);
    assert.deepEqual(await page.evaluate(() => sourceSeeks), []);
    await page.evaluate(() => updateProjectAudio('backing', 'offset', 0.05));
    await waitFor(page, () => session.projectAudio.backing.offset === 0.05);
    assert.ok((await page.evaluate(() => sourceSeeks)).some(item => item.source === 'backingAudio'));
    await page.evaluate(() => video.pause());
  });

  test('play rejection stops the microphone, clears the recording status and allows a retry', async () => {
    await loadFixture(page); await claimAndSelect(page, 1);
    await page.evaluate(() => {
      window.realVideoPlay = video.play;
      video.play = () => Promise.reject(new DOMException('Simulated failure', 'NotSupportedError'));
      localStorage.setItem('dubline_adr', 'three');
    });
    await page.evaluate(() => handleStudioRecord(1));
    await waitFor(page, () => recordState === 'idle' && mediaRecorder?.state === 'inactive' && micStream === null);
    assert.equal(await page.evaluate(() => !!session.lines[0].audioUrl), false);
    await waitFor(page, () => !liveRecordings.size);
    await page.evaluate(() => { video.play = realVideoPlay; localStorage.setItem('dubline_adr', 'off'); });
    await page.evaluate(() => handleStudioRecord(1));
    await waitFor(page, () => recordState === 'recording', 6000);
    await page.evaluate(() => finishRecording({ discard: true }));
    await waitFor(page, () => micStream === null);
  });

  test('a resolved play call with no playback progress is bounded by the recording watchdog', async () => {
    await loadFixture(page); await claimAndSelect(page, 1);
    await page.evaluate(() => { preRollSeconds = 1; video.play = () => Promise.resolve(); });
    await page.evaluate(() => handleStudioRecord(1));
    await waitFor(page, () => recordState === 'preparing');
    await waitFor(page, () => recordState === 'idle' && micStream === null, 11000);
    assert.equal(await page.evaluate(() => mediaRecorder.state), 'inactive');
    assert.equal(await page.evaluate(() => !!session.lines[0].audioUrl), false);
  });

  test('failed take downloads recover and permanent failures block export instead of omitting audio', async () => {
    await loadFixture(page);
    const result = await page.evaluate(async () => {
      const buffer = ensurePlayCtx().createBuffer(1, 4800, 48000);
      const signal = buffer.getChannelData(0); for (let i = 0; i < signal.length; i++) signal[i] = 0.05 * Math.sin(2 * Math.PI * 330 * i / 48000);
      let calls = 0;
      DublineAudioFx.fetchAndDecode = async () => { if (++calls === 1) throw new Error('offline'); return buffer; };
      DublineAudioFx.renderVoice = async b => b;
      const line = { ...session.lines[0], audioUrl: '/audit-retry', recordedBy: myName, trimEnabled: false };
      const first = await getProcessedTake(line), second = await getProcessedTake(line);
      session.lines = [{ ...line, audioUrl: '/audit-missing' }]; session.projectAudio.dub.solo = true;
      DublineAudioFx.fetchAndDecode = async () => { throw new Error('offline'); };
      try { await mixSoundtrack(5, readRenderGains(), () => {}); return { unexpectedSuccess: true }; }
      catch (error) { return { firstMissing: first === null, recovered: second === buffer, calls, code: error.code }; }
    });
    assert.deepEqual(result, { firstMissing: true, recovered: true, calls: 2, code: 'DUBLINE_EXPORT_AUDIO' });
  });

  test('real OfflineAudioContext stems keep their original timing and gain while decoding', async () => {
    await loadFixture(page);
    const result = await page.evaluate(async () => {
      const buffer = ensurePlayCtx().createBuffer(1, 4800, 48000);
      const signal = buffer.getChannelData(0); for (let i = 0; i < signal.length; i++) signal[i] = 0.05 * Math.sin(2 * Math.PI * 330 * i / 48000);
      DublineAudioFx.renderVoice = async b => b;
      let release;
      DublineAudioFx.fetchAndDecode = () => new Promise(resolve => { release = resolve; });
      session.latency[myName] = 0; session.projectAudio.dub.volume = 0.5;
      const line = { ...session.lines[0], audioUrl: '/audit-timing', audioStart: 3, recordedBy: myName, trimEnabled: false };
      const job = renderCharacterStem([line], 5);
      await new Promise(resolve => setTimeout(resolve, 50));
      session.latency[myName] = 1000; session.projectAudio.dub.volume = 0.1; line.audioStart = 0;
      release(buffer);
      const rendered = await job, data = rendered.getChannelData(0);
      const peak = start => Math.max(...data.subarray(start * 48000, start * 48000 + 4000).map(Math.abs));
      session.latency[myName] = 0; session.projectAudio.dub.volume = 1;
      const unity = await renderCharacterStem([{ ...line, audioStart: 3 }], 5);
      return { early: peak(2), expected: peak(3), unity: Math.max(...unity.getChannelData(0).subarray(3 * 48000, 3 * 48000 + 4000).map(Math.abs)) };
    });
    assert.equal(result.early, 0); assert.ok(Math.abs(result.expected / result.unity - 0.5) < 0.001, JSON.stringify(result));
  });

  test('fallback video rendering aborts and cleans up when the scene changes', async () => {
    await loadFixture(page); await waitFor(page, () => video.readyState >= 3);
    const result = await page.evaluate(async () => {
      renderInProgress = true;
      const snapshot = createExportSnapshot(), task = renderRealtime(() => {}, snapshot);
      setTimeout(() => { session.activeSessionId = 'different-scene'; }, 700);
      try { await task; return { unexpectedSuccess: true }; }
      catch (error) { return { code: error.code, paused: video.paused }; }
      finally { renderInProgress = false; }
    });
    assert.deepEqual(result, { code: 'DUBLINE_EXPORT_SCENE', paused: true });
  });
});
