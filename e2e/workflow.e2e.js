const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipReason, launchBrowser, startServer, openPlayer, waitFor, wait, loadFixture, claimAndSelect, fixtureVideoPath } = require('./helpers');

describe('Studio Workflow 1.3', { skip: skipReason }, () => {
  let server, browser, host, guest, original, background, subtitles, firstSession;
  const mix = (page, channel, field, value, extra = {}) => page.evaluate((channel, field, value, extra) => new Promise(resolve => {
    socket.emit('project_audio_update', { channel, field, value, sessionId: session.activeSessionId, revision: session.projectAudio.revision, ...extra }, resolve);
  }), channel, field, value, extra);
  const set = async (channel, field, value) => {
    const result = await mix(host, channel, field, value);
    assert.equal(result.ok, true, JSON.stringify(result));
    await waitFor(guest, revision => session.projectAudio.revision === revision, 5000, result.mix.revision);
    return result;
  };
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    original = path.join(server.dirs.data, 'original.wav'); background = path.join(server.dirs.data, 'background.wav'); subtitles = path.join(server.dirs.data, 'scene.srt');
    for (const [file, frequency, duration] of [[original, 660, 2], [background, 220, 4]]) {
      const result = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`, '-ar', '48000', file]);
      assert.equal(result.status, 0, String(result.stderr));
    }
    fs.writeFileSync(subtitles, '1\n00:00:01,234 --> 00:00:02,345\n[Hero] Hello\n');
    host = await openPlayer(browser, server.url('workflow'), 'Alice');
    guest = await openPlayer(browser, server.url('workflow'), 'Bob');
    await waitFor(host, () => amHost());
  });
  after(async () => { if (browser) await browser.close(); if (server) await server.cleanup(); });

  test('imports every optional-source combination through the real form', async () => {
    for (const combination of [[], ['subtitles'], ['original'], ['background'], ['original', 'background'], ['original', 'background', 'subtitles']]) {
      const previous = await host.evaluate(() => session.activeSessionId);
      await host.evaluate(() => { openFilesModal(); switchFilesTab('packs'); });
      await (await host.$('#customVideoInput')).uploadFile(fixtureVideoPath());
      if (combination.includes('original')) await (await host.$('#customOriginalInput')).uploadFile(original);
      if (combination.includes('background')) await (await host.$('#customIntershumInput')).uploadFile(background);
      if (combination.includes('subtitles')) await (await host.$('#customSubInput')).uploadFile(subtitles);
      await host.evaluate(() => uploadCustomScene());
      await waitFor(host, previous => session.loaded && session.activeSessionId !== previous, 15000, previous);
      const scene = await host.evaluate(() => ({ id: session.activeSessionId, mode: session.mode, lines: session.lines, original: session.externalOriginalUrl, background: session.backingUrl,
        empty: ['customVideoInput', 'customOriginalInput', 'customIntershumInput', 'customSubInput'].every(id => !document.getElementById(id).value) }));
      if (!firstSession) firstSession = scene.id;
      assert.equal(scene.mode, combination.includes('subtitles') ? 'dub' : 'edit');
      assert.equal(scene.lines.length, combination.includes('subtitles') ? 1 : 0);
      assert.equal(!!scene.original, combination.includes('original')); assert.equal(!!scene.background, combination.includes('background')); assert.equal(scene.empty, true);
      if (scene.lines.length) assert.equal(scene.lines[0].start, 1.234);
      await waitFor(guest, id => session.activeSessionId === id, 5000, scene.id);
      await waitFor(host, external => document.querySelector('[data-audio-channel=original] .studio-wave-source').textContent === (external ? 'original.wav' : 'Audio from video'), 5000, combination.includes('original'));
      if (!combination.length) {
        const created = await host.evaluate(() => queueEditorRequest(() => ['editor_create_line', { character: 'Manual role', caption: 'Manual line', start: 0.123, end: 1.234 }]));
        assert.equal(created.ok, true);
        await waitFor(guest, () => session.lines.length === 1 && session.lines[0].caption === 'Manual line');
        assert.equal((await host.evaluate(() => editorUndo())).undone, 1);
        await waitFor(guest, () => session.lines.length === 0);
      }
    }
    await host.evaluate(() => closeFilesModal());
    assert.deepEqual(host.dialogs, [], 'valid imports never show an error');
  });

  test('bad files are rejected atomically, while valid current media stays available', async () => {
    const id = await host.evaluate(() => session.activeSessionId);
    const video = fs.readFileSync(fixtureVideoPath()).toString('base64');
    for (const [name, contents, videoData] of [['bad.txt', 'bad', video], ['bad.wav', 'not audio', video], [null, null, 'broken']]) {
      const status = await host.evaluate(async (name, contents, videoData) => {
        const form = new FormData(); form.append('clientId', clientId); form.append('userName', myName);
        const bytes = videoData === 'broken' ? 'not video' : Uint8Array.from(atob(videoData), c => c.charCodeAt(0));
        form.append('video', new Blob([bytes]), 'scene.mp4');
        if (name) form.append('original', new Blob([contents]), name);
        return (await fetch(`/api/upload-custom?room=${currentRoom}`, { method: 'POST', body: form })).status;
      }, name, contents, videoData);
      assert.equal(status, 400);
      assert.equal(await host.evaluate(() => session.activeSessionId), id);
    }
  });

  test('waveforms show actual source durations, are cached on disk and deny arbitrary sources', async () => {
    const data = await host.evaluate(async () => {
      const read = channel => fetch(`/api/audio-waveform?${new URLSearchParams({ room: currentRoom, sessionId: session.activeSessionId, channel })}`).then(res => res.json());
      return { original: await read('original'), backing: await read('backing'), repeat: await read('original'), invalid: (await fetch(`/api/audio-waveform?room=${currentRoom}&sessionId=${session.activeSessionId}&channel=../../server.js`)).status };
    });
    assert.ok(Math.abs(data.original.duration - 2) < 0.1); assert.ok(Math.abs(data.backing.duration - 4) < 0.1);
    assert.ok(data.original.peaks.some(peak => peak > 0.05)); assert.deepEqual(data.original, data.repeat); assert.equal(data.invalid, 404);
    const sceneDirs = fs.readdirSync(server.dirs.uploads).filter(name => name.startsWith('custom_'));
    assert.ok(sceneDirs.some(dir => fs.readdirSync(path.join(server.dirs.uploads, dir)).some(name => name.startsWith('.waveform-'))));
    assert.equal(await host.evaluate(() => document.querySelectorAll('.studio-audio-row').length), 3);
  });

  test('shared project controls sync; guests can adjust personal monitoring without mutating export', async () => {
    await host.evaluate(() => { const slider = document.querySelector('#volOriginal'); slider.value = '75'; slider.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(guest, () => session.projectAudio.original.volume === 0.75);
    assert.equal((await mix(guest, 'original', 'volume', 0.2)).reason, 'host');
    const originalMix = await guest.evaluate(() => structuredClone(session.projectAudio));
    // A guest moving a project slider is switched to their own monitoring instead of being blocked
    await guest.evaluate(() => { const slider = document.querySelector('#volOriginal'); slider.value = '40'; slider.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await guest.evaluate(() => document.querySelector('[data-studio-mix]').value), 'monitor');
    assert.equal(await guest.evaluate(() => studioPlaybackVolumes().original), 0.4);
    assert.deepEqual(await guest.evaluate(() => session.projectAudio), originalMix, 'the project mix is untouched');
    await guest.select('[data-studio-mix]', 'project');
    await guest.select('[data-studio-mix]', 'monitor');
    await guest.evaluate(() => { const slider = document.querySelector('#volOriginal'); slider.value = '25'; slider.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await guest.evaluate(() => studioPlaybackVolumes().original), 0.25);
    assert.equal(await guest.evaluate(() => readRenderGains().original), 0.75);
    assert.deepEqual(await guest.evaluate(() => session.projectAudio), originalMix);
    await guest.reload(); await waitFor(guest, () => session && session.loaded);
    assert.equal(await guest.evaluate(() => studioPlaybackVolumes().original), 0.25);
    await guest.evaluate(() => document.querySelector('[data-studio-action=monitor-reset]').click());
    assert.equal(await guest.evaluate(() => studioPlaybackVolumes().original), 0.75);
    await host.evaluate(() => setStudioMode('edit')); await waitFor(guest, () => session.mode === 'edit');
    assert.equal((await mix(guest, 'backing', 'volume', 0.6)).ok, true);
    await waitFor(host, () => session.projectAudio.backing.volume === 0.6);
    const bad = await mix(host, 'dub', 'offset', 1); assert.equal(bad.reason, 'invalid');
    assert.equal((await mix(host, 'original', 'offset', NaN)).reason, 'invalid');
    const before = await host.evaluate(() => session.projectAudio.revision);
    await set('original', 'offset', 0.345);
    assert.equal((await mix(host, 'original', 'volume', 0.1, { revision: before })).reason, 'conflict');
    assert.equal((await mix(host, 'original', 'volume', 0.1, { sessionId: firstSession })).reason, 'session');
  });

  test('expanded audio uses the same zoom / scroll grid, and moved character lines remain visible', async () => {
    const before = await host.evaluate(() => pxPerSec);
    await host.evaluate(() => zoomTimeline(1.25));
    const layout = await host.evaluate(() => {
      timelineContainer.scrollLeft = 200;
      const audioWidth = document.querySelector('.studio-wave-area').getBoundingClientRect().width;
      const roleWidth = document.querySelector('.track-timeline').getBoundingClientRect().width;
      return { zoom: pxPerSec, audioWidth, roleWidth };
    });
    assert.ok(layout.zoom > before); assert.ok(Math.abs(layout.audioWidth - layout.roleWidth) < 1);
    await waitFor(host, () => document.querySelector('.studio-wave-area canvas').width > 0);
    await host.evaluate(() => fitTimeline());
    await waitFor(host, () => timelineContainer.scrollWidth <= timelineContainer.clientWidth + 3, 3000).catch(async error => {
      throw new Error(`${error.message}: ${JSON.stringify(await host.evaluate(() => ({ zoom: pxPerSec, width: timelineContainer.clientWidth, scroll: timelineContainer.scrollWidth,
        children: [...timeline.children].map(el => ({ class: el.className, width: el.getBoundingClientRect().width, scroll: el.scrollWidth })) })))}`);
    });
    assert.equal(await host.evaluate(() => timelineContainer.scrollWidth <= timelineContainer.clientWidth + 3), true);
    const lineId = await host.evaluate(() => { selectLine(session.lines[0]); return session.lines[0].id; });
    await host.evaluate(id => updateEditorLine(session.lines.find(line => line.id === id), { character: 'Moved role' }), lineId);
    await waitFor(host, id => {
      const tile = document.getElementById(`line-block-${id}`), rect = tile.getBoundingClientRect(), view = timelineContainer.getBoundingClientRect();
      return rect.top >= view.top && rect.bottom <= view.bottom;
    }, 5000, lineId).catch(async error => { throw new Error(`${error.message}: ${JSON.stringify(await host.evaluate(id => {
      const tile = document.getElementById(`line-block-${id}`), r = tile.getBoundingClientRect(), v = timelineContainer.getBoundingClientRect();
      return { tile: { top: r.top, bottom: r.bottom }, view: { top: v.top, bottom: v.bottom }, scrollTop: timelineContainer.scrollTop, revealLineId, selected: selectedLine?.id };
    }, lineId))}`); });
  });

  test('millisecond offsets align both external sources, stop at their boundaries and render correctly', async () => {
    await set('backing', 'offset', -0.456);
    await host.evaluate(() => { video.pause(); video.currentTime = 1.5; });
    await waitFor(host, () => !video.seeking && originalTrackAudio.readyState > 0 && backing.readyState > 0);
    const position = await host.evaluate(() => { syncProjectSources(true); return { original: originalTrackAudio.currentTime, backing: backing.currentTime }; });
    assert.ok(Math.abs(position.original - 1.155) < 0.03); assert.ok(Math.abs(position.backing - 1.956) < 0.03);
    await host.evaluate(() => { video.currentTime = 0.1; }); await waitFor(host, () => !video.seeking);
    assert.equal(await host.evaluate(() => { syncProjectSources(true); return originalTrackAudio.paused && originalTrackAudio.currentTime === 0; }), true);
    await set('original', 'solo', true); await set('original', 'volume', 0.5); await set('original', 'offset', 1);
    const energy = await host.evaluate(async () => {
      const buffer = await mixSoundtrack(5, readRenderGains(), () => {}), data = buffer.getChannelData(0);
      const rms = (from, to) => { let sum = 0; const a = Math.floor(from * buffer.sampleRate), b = Math.floor(to * buffer.sampleRate); for (let i = a; i < b; i++) sum += data[i] ** 2; return Math.sqrt(sum / (b - a)); };
      return [rms(0.2, 0.6), rms(1.3, 1.7), rms(3.4, 3.8)];
    });
    assert.ok(energy[0] < 0.0001 && energy[2] < 0.0001, JSON.stringify(energy)); assert.ok(energy[1] > 0.02 && energy[1] < 0.07);
    await set('original', 'offset', -0.5);
    const negative = await host.evaluate(async () => {
      const buffer = await mixSoundtrack(3, readRenderGains(), () => {}), data = buffer.getChannelData(0);
      return { early: Math.max(...data.subarray(12000, 14000).map(Math.abs)), late: Math.max(...data.subarray(100000, 102000).map(Math.abs)) };
    });
    assert.ok(negative.early > 0.02); assert.ok(negative.late < 0.0001);
    await set('original', 'muted', true);
    assert.deepEqual(await host.evaluate(() => { const g = readRenderGains(); return { original: g.original, backing: g.backing, dub: g.dub }; }), { original: 0, backing: 0, dub: 0 });
    await set('original', 'muted', false);
  });

  test('the Audio group starts collapsed on a new device and opens with one click', async () => {
    const fresh = await openPlayer(browser, server.url('workflow'), 'Carol', { audioExpanded: false });
    try {
      await waitFor(fresh, () => session && session.loaded && !!document.querySelector('[data-studio-action=audio]'));
      assert.equal(await fresh.evaluate(() => document.querySelectorAll('.studio-audio-row').length), 0);
      assert.equal(await fresh.$eval('[data-studio-action=audio]', button => button.getAttribute('aria-expanded')), 'false');
      await fresh.click('[data-studio-action=audio]');
      assert.equal(await fresh.evaluate(() => document.querySelectorAll('.studio-audio-row').length), 3);
    } finally { await fresh.close(); }
  });

  test('audio collapse, compact lobby and project mix persist across reload / server restart / session switches', async () => {
    const saved = await host.evaluate(() => structuredClone(session.projectAudio));
    await host.click('[data-studio-action=audio]'); assert.equal(await host.evaluate(() => document.querySelectorAll('.studio-audio-row').length), 0);
    await host.click('[data-studio-action=lobby]');
    await host.reload(); await waitFor(host, () => session && session.loaded);
    assert.equal(await host.evaluate(() => document.body.classList.contains('lobby-compact') && document.querySelectorAll('.studio-audio-row').length === 0), true);
    await server.restart(); await waitFor(host, () => socket.connected);
    await waitFor(host, saved => session && JSON.stringify(session.projectAudio) === JSON.stringify(saved), 10000, saved);
    const current = await host.evaluate(() => session.activeSessionId);
    await host.evaluate(id => socket.emit('host_switch_session', { id }), firstSession);
    await waitFor(host, id => session.activeSessionId === id, 5000, firstSession);
    assert.equal(await host.evaluate(() => session.projectAudio.original.offset), 0);
    await host.evaluate(id => socket.emit('host_switch_session', { id }), current);
    await waitFor(host, id => session.activeSessionId === id, 5000, current);
    assert.deepEqual(await host.evaluate(() => session.projectAudio), saved);
    await host.click('[data-studio-action=audio]'); await host.click('[data-studio-action=lobby]');
  });

  test('transport keys ignore text fields, keep editor arrows and obey watch host / guest authority', async () => {
    await host.evaluate(() => { video.pause(); video.currentTime = 5; document.activeElement.blur(); });
    await host.keyboard.press('KeyJ'); await waitFor(host, () => Math.abs(video.currentTime - 2) < 0.1);
    await host.keyboard.press('KeyL'); await waitFor(host, () => Math.abs(video.currentTime - 5) < 0.1);
    await host.keyboard.press('Space'); await waitFor(host, () => !video.paused); await host.keyboard.press('KeyK'); await waitFor(host, () => video.paused);
    await host.evaluate(() => { const field = document.createElement('div'); field.contentEditable = 'true'; field.id = 'editable-shortcut-test'; document.body.appendChild(field); field.focus(); });
    const before = await host.evaluate(() => video.currentTime); await host.keyboard.press('KeyJ'); assert.equal(await host.evaluate(() => video.currentTime), before);
    await host.evaluate(() => document.querySelector('#editable-shortcut-test').remove());
    const bounds = await host.evaluate(() => { selectLine(session.lines[0]); return { id: session.lines[0].id, start: session.lines[0].start }; });
    await host.evaluate(() => document.activeElement.blur()); await host.keyboard.press('ArrowRight');
    await waitFor(host, bounds => session.lines.find(line => line.id === bounds.id).start > bounds.start, 5000, bounds);
    await host.evaluate(() => editorUndo());
    await host.evaluate(() => setStudioMode('dub')); await waitFor(guest, () => session.mode === 'dub');
    await host.evaluate(() => hostWatchStart()); await waitFor(guest, () => watchMode); await waitFor(guest, () => !video.paused, 6000);
    await host.evaluate(() => video.pause()); await waitFor(guest, () => video.paused);
    const position = await host.evaluate(() => video.currentTime);
    await guest.evaluate(() => document.activeElement.blur()); for (const key of ['Space', 'KeyJ', 'KeyK', 'KeyL']) await guest.keyboard.press(key);
    assert.equal(await guest.evaluate(() => video.paused), true); assert.ok(Math.abs(await host.evaluate(() => video.currentTime) - position) < 0.05);
    await guest.evaluate(() => leaveWatch()); await guest.keyboard.press('Space'); await waitFor(guest, () => !video.paused); await guest.keyboard.press('KeyK');
    await host.evaluate(() => hostWatchStop()); await waitFor(host, () => !watchMode);
    await host.evaluate(() => { window.fullscreenShortcutCalled = 0; window.toggleVideoFullscreen = async () => { fullscreenShortcutCalled++; }; document.activeElement.blur(); });
    await host.keyboard.press('KeyF'); assert.equal(await host.evaluate(() => fullscreenShortcutCalled), 1);
  });

  test('ADR is off initially; three cues near zero stay outside the take / export graph and cancel immediately', async () => {
    await loadFixture(host); await waitFor(guest, () => session.lines.length === 4);
    assert.equal(await host.evaluate(() => document.querySelector('[data-studio-setting=adr]').value), 'off');
    await host.evaluate(() => setStudioMode('edit')); await waitFor(host, () => session.mode === 'edit');
    await host.evaluate(() => updateEditorLine(session.lines[0], { start: 0, end: 1 }));
    await host.evaluate(() => setStudioMode('dub')); await waitFor(host, () => session.mode === 'dub'); await claimAndSelect(host, 1);
    await host.evaluate(() => openSettingsModal());
    await host.select('[data-studio-setting=adr]', 'three');
    await host.evaluate(() => closeSettingsModal());
    await host.evaluate(() => {
      window.adrEvents = [];
      const Oscillator = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function() { const node = Oscillator.call(this), start = node.start.bind(node); node.start = (...args) => { adrEvents.push({ scheduled: args[0], audio: video.currentTime, frequency: node.frequency.value }); start(...args); }; return node; };
      preRollSeconds = 0.1; cueEnabled = false;
    });
    await host.evaluate(() => handleStudioRecord(1));
    await waitFor(host, () => adrEvents.length === 3, 4000);
    const beeps = await host.evaluate(() => adrEvents);
    assert.equal(beeps[1].scheduled - beeps[0].scheduled, 1); assert.equal(beeps[2].scheduled - beeps[1].scheduled, 1);
    assert.ok(beeps.every(item => item.frequency === 880 && item.audio < 0.05));
    await host.evaluate(() => finishRecording({ discard: true })); const count = beeps.length; await wait(1200);
    assert.equal(await host.evaluate(() => adrEvents.length), count); assert.equal(await host.evaluate(() => recordState === 'idle' && video.paused), true);
    await host.evaluate(() => handleStudioRecord(1)); await wait(200); await host.evaluate(() => finishRecording({ discard: true }));
    const cancelled = await host.evaluate(() => adrEvents.length); await wait(2200); assert.equal(await host.evaluate(() => adrEvents.length), cancelled);
    await host.reload(); await waitFor(host, () => session && session.loaded); assert.equal(await host.evaluate(() => document.querySelector('[data-studio-setting=adr]').value), 'three');
  });

  test('Dub mute / solo and levels apply to final audio and character stems, not personal monitoring', async () => {
    // A short decoded take is deterministic, independent of the fake microphone.
    await host.evaluate(async () => {
      const line = session.lines[0], ctx = new AudioContext();
      const buffer = ctx.createBuffer(1, 48000, 48000), data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = 0.1 * Math.sin(2 * Math.PI * 330 * i / 48000);
      await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: line.id, nick: myName, audioStart: 0, trimStart: 0, trimEnd: 1,
        blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() });
      await ctx.close();
    });
    await waitFor(host, () => !!session.lines[0].audioUrl);
    await set('dub', 'solo', true); await set('dub', 'volume', 1);
    const peak = () => host.evaluate(async () => {
      const mixed = await mixSoundtrack(2, readRenderGains(), () => {}), stem = await renderCharacterStem([session.lines[0]], 2);
      const max = buffer => Math.max(...buffer.getChannelData(0).subarray(12000, 14000).map(Math.abs));
      return { mixed: max(mixed), stem: max(stem) };
    });
    const unity = await peak(); await set('dub', 'volume', 0.4);
    const sound = await peak();
    assert.ok(Math.abs(sound.mixed / unity.mixed - 0.4) < 0.015, JSON.stringify({ sound, unity }));
    assert.ok(Math.abs(sound.stem / unity.stem - 0.4) < 0.015, JSON.stringify({ sound, unity }));
    await set('dub', 'muted', true); const silent = await peak(); assert.equal(silent.mixed, 0); assert.equal(silent.stem, 0);
  });

  test('video-source captions follow the selected UI language without changing audio', async () => {
    const originalUrl = await host.evaluate(() => DublineProjectAudio.sources(session).original);
    for (const [language, label] of [['ru', 'Звук из видео'], ['uk', 'Звук із відео'], ['en', 'Audio from video']]) {
      await host.evaluate(language => DublineI18n.setLanguage(language), language);
      assert.equal(await host.$eval('[data-audio-channel=original] .studio-wave-source', el => el.textContent), label);
      assert.equal(await host.evaluate(() => DublineProjectAudio.sources(session).original), originalUrl);
    }
  });

  test('compact lobby preserves initials, every status badge, tooltips and download progress', async () => {
    const compact = (page, wanted) => page.evaluate(wanted => {
      if (document.body.classList.contains('lobby-compact') !== wanted) document.querySelector('[data-studio-action=lobby]').click();
    }, wanted);
    const card = (page, nick) => page.evaluate(nick => {
      const element = [...document.querySelectorAll('#lobbyList .player-card')].find(el => el.querySelector('.player-name').textContent === nick);
      if (!element) return null;
      const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      return { initials: element.querySelector('.avatar').firstChild.textContent, avatarVisible: visible(element.querySelector('.avatar')),
        nameVisible: visible(element.querySelector('.player-name')), offline: element.classList.contains('offline'),
        badges: [...element.querySelectorAll('.player-status-icons span')].map(el => ({ text: el.textContent, title: el.title, visible: visible(el) })),
        progress: [...element.querySelectorAll('.progress > div')].map(el => ({ width: el.style.width, visible: visible(el) })),
        labels: { host: t('lobby.host'), you: t('lobby.you'), recording: t('lobby.recording', { id: 2 }), seeding: t('lobby.seeding'), downloading: t('lobby.downloading', { pct: 42 }), offline: t('studio.offline'), done: t('studio.done') } };
    }, nick);
    const hasBadge = (state, title) => state.badges.some(badge => badge.title === title && badge.visible);
    await claimAndSelect(guest, 2);
    await compact(host, true); await compact(guest, true);
    let alice = await card(host, 'Alice'), bob = await card(guest, 'Bob');
    assert.equal(alice.initials, 'AL'); assert.equal(bob.initials, 'BO');
    assert.equal(alice.avatarVisible && bob.avatarVisible, true); assert.equal(alice.nameVisible || bob.nameVisible, false);
    assert.ok(hasBadge(alice, alice.labels.host) && hasBadge(alice, alice.labels.you)); assert.ok(hasBadge(bob, bob.labels.you));
    await guest.evaluate(() => socket.emit('recording_status', { sessionId: session.activeSessionId,  lineId: 2, recording: true }));
    await waitFor(host, () => liveRecordings.get(2) === 'Bob');
    bob = await card(host, 'Bob'); assert.ok(hasBadge(bob, bob.labels.recording));
    await guest.evaluate(() => socket.emit('recording_status', { sessionId: session.activeSessionId,  lineId: 2, recording: false }));
    await waitFor(host, () => !liveRecordings.has(2));
    await guest.evaluate(async () => {
      const manifest = await (await fetch(`/api/media-manifest?${new URLSearchParams({ room: currentRoom, sessionId: session.activeSessionId, clientId, url: session.videoUrl })}`)).json();
      socket.emit('p2p_have', { sessionId: session.activeSessionId, sequence: ++availabilitySequence, files: [{ url: session.videoUrl, id: manifest.id, ranges: [[0, manifest.chunks.length - 1]] }] });
    });
    await waitFor(host, () => seedingNicks.has('Bob'));
    // Download progress is deliberately volatile; report it independently of reliable state changes.
    await guest.evaluate(() => window.updateMediaTransfer({ downloading: true, pct: 42 }));
    await waitFor(host, () => playerActivities.get('Bob')?.pct === 42);
    await waitFor(host, () => [...document.querySelectorAll('#lobbyList .player-card')].some(card => card.querySelector('.player-name')?.textContent === 'Bob' && [...card.querySelectorAll('.progress > div')].some(bar => bar.style.width === '42%')));
    bob = await card(host, 'Bob');
    assert.ok(hasBadge(bob, bob.labels.seeding) && hasBadge(bob, bob.labels.downloading));
    assert.ok(bob.progress.some(progress => progress.width === '42%' && progress.visible));
    assert.ok(bob.badges.every(badge => badge.title.trim()), 'every icon has a readable tooltip');
    await guest.evaluate(async () => {
      const ctx = new AudioContext(), buffer = ctx.createBuffer(1, 9600, 48000), data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = 0.05 * Math.sin(2 * Math.PI * 330 * i / 48000);
      await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: 2, nick: myName,
        audioStart: session.lines.find(line => line.id === 2).start, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() });
      window.updateMediaTransfer({ downloading: false, pct: 100 }); await ctx.close();
    });
    await waitFor(host, () => !!session.lines.find(line => line.id === 2).audioUrl);
    bob = await card(host, 'Bob'); assert.ok(hasBadge(bob, bob.labels.done));
    await guest.evaluate(() => socket.disconnect());
    await waitFor(host, () => !lastOnlineUsers.includes('Bob') && !seedingNicks.has('Bob') && !playerActivities.has('Bob'));
    bob = await card(host, 'Bob'); assert.equal(bob.offline, true); assert.ok(hasBadge(bob, bob.labels.offline) && hasBadge(bob, bob.labels.done));
    assert.ok(!hasBadge(bob, bob.labels.recording) && !hasBadge(bob, bob.labels.seeding) && !hasBadge(bob, bob.labels.downloading));
    await guest.evaluate(() => socket.connect()); await waitFor(host, () => lastOnlineUsers.includes('Bob'));
    await host.reload(); await waitFor(host, () => session && session.loaded && lastOnlineUsers.includes('Bob'));
    assert.equal(await host.evaluate(() => document.body.classList.contains('lobby-compact')), true);
    await compact(host, false); await compact(guest, false);
    alice = await card(host, 'Alice'); bob = await card(host, 'Bob'); assert.equal(alice.nameVisible && bob.nameVisible, true);
    assert.equal(bob.offline, false);
  });

  test('first visit defaults to English on a Russian browser and preserves a later language choice', async () => {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'language', { value: 'ru-RU' }); localStorage.setItem('dubline_help_seen', '1'); });
    await page.goto(server.url('language')); assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    await page.evaluate(() => DublineI18n.setLanguage('uk')); await page.reload(); assert.equal(await page.evaluate(() => document.documentElement.lang), 'uk');
    await context.close();
  });
  test('no browser errors', () => { assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []); });
});

describe('Project mix export matrix', { skip: skipReason }, () => {
  let server, browser, page;
  const channels = ['original', 'backing', 'dub'];
  const levels = { original: 0.5, backing: 0.4, dub: 0.3 };
  const frequencies = { original: 660, backing: 220, dub: 330 };
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    page = await openPlayer(browser, server.url('export-matrix'), 'Alice');
    const files = {};
    for (const channel of ['original', 'backing']) {
      const file = path.join(server.dirs.data, `${channel}.wav`);
      const generated = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequencies[channel]}:duration=2`, '-ar', '48000', file]);
      assert.equal(generated.status, 0, String(generated.stderr)); files[channel] = fs.readFileSync(file).toString('base64');
    }
    files.video = fs.readFileSync(fixtureVideoPath()).toString('base64');
    const status = await page.evaluate(async files => {
      const form = new FormData(); form.append('clientId', clientId);
      const bytes = key => Uint8Array.from(atob(files[key]), c => c.charCodeAt(0));
      form.append('video', new Blob([bytes('video')]), 'scene.mp4');
      form.append('original', new Blob([bytes('original')]), 'original.wav');
      form.append('intershum', new Blob([bytes('backing')]), 'backing.wav');
      form.append('subtitles', new Blob(['1\n00:00:00,000 --> 00:00:02,000\n[Hero] Test\n']), 'scene.srt');
      return (await fetch(`/api/upload-custom?room=${currentRoom}`, { method: 'POST', body: form })).status;
    }, files);
    assert.equal(status, 200); await waitFor(page, () => session.loaded && session.lines.length === 1 && video.readyState >= 3);
    await claimAndSelect(page, 1);
    await page.evaluate(async () => {
      const buffer = ensurePlayCtx().createBuffer(1, 96000, 48000), data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = 0.08 * Math.sin(2 * Math.PI * 330 * i / 48000);
      await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: 1, nick: myName, audioStart: 0,
        trimEnabled: false, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() });
    });
    await waitFor(page, () => !!session.lines[0].audioUrl);
  });
  after(async () => { if (browser) await browser.close(); if (server) await server.cleanup(); });

  for (const [name, selected, solo] of [
    ['Original only', ['original'], true], ['Intershum only', ['backing'], false], ['Dub only', ['dub'], true],
    ['Intershum + Dub', ['backing', 'dub'], false], ['Original + Dub', ['original', 'dub'], true],
    ['Original + Intershum + Dub', channels, false]
  ]) test(`${name}: offline mix and final MP4 contain exactly the selected channels at project levels`, async () => {
    const result = await page.evaluate(async ({ channels, selected, solo, levels, frequencies }) => {
      const set = async (channel, field, value) => {
        const reply = await new Promise(resolve => socket.emit('project_audio_update', { channel, field, value, sessionId: session.activeSessionId, revision: session.projectAudio.revision }, resolve));
        if (!reply.ok) throw new Error(JSON.stringify(reply));
      };
      await set('settings', 'autoDuckEnabled', false);
      for (const channel of channels) {
        await set(channel, 'volume', levels[channel]); await set(channel, 'muted', !solo && !selected.includes(channel));
        await set(channel, 'solo', solo && selected.includes(channel));
        if (channel !== 'dub') await set(channel, 'offset', 0);
      }
      // A muted private monitor must never silence the shared exported mix.
      const picker = document.querySelector('[data-studio-mix]'); picker.value = 'monitor'; picker.dispatchEvent(new Event('change', { bubbles: true }));
      for (const channel of channels) {
        const slider = document.querySelector(`[data-audio-channel=${channel}] [data-audio-field=volume]`);
        slider.value = 0; slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const amplitude = (buffer, frequency) => {
        const data = buffer.getChannelData(0), from = Math.round(0.5 * buffer.sampleRate), to = Math.round(buffer.sampleRate);
        let sine = 0, cosine = 0;
        for (let i = from; i < to; i++) { const angle = 2 * Math.PI * frequency * i / buffer.sampleRate; sine += data[i] * Math.sin(angle); cosine += data[i] * Math.cos(angle); }
        return 2 * Math.hypot(sine, cosine) / (to - from);
      };
      const soundtrack = await mixSoundtrack(2, readRenderGains(), () => {});
      // Chromium's limiter has automatic makeup gain even below its threshold.
      // Compare against a unity reference through that same master, not raw sine amplitude.
      const unity = await mixSoundtrack(2, { original: 1, backing: 1, dub: 1, mix: readRenderGains().mix }, () => {});
      const blob = await renderWithWebCodecs(() => {});
      const decoded = await ensurePlayCtx().decodeAudioData(await blob.arrayBuffer());
      const measure = buffer => Object.fromEntries(channels.map(channel => [channel, amplitude(buffer, frequencies[channel])]));
      return { mixed: measure(soundtrack), unity: measure(unity), mp4: measure(decoded), gains: readRenderGains(), monitoring: studioPlaybackVolumes(), size: blob.size };
    }, { channels, selected, solo, levels, frequencies });
    assert.ok(result.size > 1000); assert.equal(result.monitoring.original + result.monitoring.backing + result.monitoring.recorded, 0);
    for (const channel of channels) {
      assert.equal(result.gains[channel], selected.includes(channel) ? levels[channel] : 0);
      if (!selected.includes(channel)) {
        assert.ok(result.mixed[channel] < 0.001 && result.mp4[channel] < 0.001, `${channel} must be silent: ${JSON.stringify(result)}`);
      } else {
        assert.ok(result.unity[channel] > 0.05, `${channel} reference must contain sound`);
        const expected = result.unity[channel] * levels[channel];
        assert.ok(Math.abs(result.mixed[channel] - expected) / expected < 0.03, `${channel} offline gain: ${JSON.stringify(result)}`);
        assert.ok(Math.abs(result.mp4[channel] - expected) / expected < 0.1, `${channel} encoded gain: ${JSON.stringify(result)}`);
      }
    }
  });
  test('no export-matrix browser errors', () => assert.deepEqual(page.errors, []));
});
