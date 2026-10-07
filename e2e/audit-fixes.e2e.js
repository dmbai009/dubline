const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, waitUntil, wait,
  answerTextPrompt, buildFixturePack, buildMultiTrackVideo, claimAndSelect } = require('./helpers');

describe('audit: actual editor controls and recording queue', { skip: skipReason }, () => {
  let server, browser, host, guest, serial = 0;
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  beforeEach(async () => {
    const room = `controls_${++serial}`;
    host = await openPlayer(browser, server.url(room), 'Alice');
    guest = await openPlayer(browser, server.url(room), 'Bob');
    await loadFixture(host); await waitFor(guest, () => session?.loaded && Number.isFinite(video.duration));
  });
  afterEach(async () => { await host?.close(); await guest?.close(); });
  async function edit() {
    await host.click('#editModeBtn'); await waitFor(guest, () => session.mode === 'edit');
  }
  async function alt(page, direction) {
    await page.keyboard.down('Alt'); await page.keyboard.press(direction); await page.keyboard.up('Alt');
  }
  async function blankClick(page, character, time) {
    const point = await page.evaluate((character, time) => {
      const area = [...document.querySelectorAll('.track-row')].find(row => row.dataset.character === character).querySelector('.track-timeline');
      const scrollLeft = timelineContainer.scrollLeft;
      area.scrollIntoView({ block: 'center', inline: 'nearest' });
      timelineContainer.scrollLeft = scrollLeft;
      const box = area.getBoundingClientRect();
      return { x: box.left + time * pxPerSec, y: box.top + 12 };
    }, character, time);
    await page.mouse.click(point.x, point.y, { count: 2 });
  }
  async function take(page, uploadId, sequence, audioStart = 0) {
    return page.evaluate(async (uploadId, sequence, audioStart) => {
      const blob = await (await fetch(session.lines[0].originalAudioUrl)).blob();
      const entry = { uploadId, takeSequence: sequence || await reserveTake(1, session.activeSessionId),
        room: currentRoom, sessionId: session.activeSessionId, lineId: 1, nick: myName,
        audioStart, blob, createdAt: Date.now() };
      await submitTake(entry); return entry.takeSequence;
    }, uploadId, sequence, audioStart);
  }

  test('Alt+arrows move a selected line; text entry, track boundaries and Dub Mode are respected', async () => {
    await edit(); await guest.click('#line-block-1');
    await alt(guest, 'ArrowDown');
    await waitFor(host, () => session.lines.find(line => line.id === 1).character === 'Friend');
    await guest.evaluate(() => editorQueue);
    await alt(guest, 'ArrowDown'); await guest.focus('#editorCaption'); await alt(guest, 'ArrowUp');
    assert.equal(await guest.evaluate(() => session.lines.find(line => line.id === 1).character), 'Friend');
    await guest.evaluate(() => document.activeElement.blur()); await alt(guest, 'ArrowUp');
    await waitFor(host, () => session.lines.find(line => line.id === 1).character === 'Hero');
    await host.click('#dubModeBtn'); await waitFor(guest, () => session.mode === 'dub'); await alt(guest, 'ArrowDown');
    assert.equal(await guest.evaluate(() => session.lines.find(line => line.id === 1).character), 'Hero');
  });
  test('Alt+arrows move a multi-selection atomically and Undo restores both lines', async () => {
    await edit(); await guest.click('#line-block-1'); await guest.keyboard.down('Control');
    await guest.click('#line-block-3'); await guest.keyboard.up('Control'); await alt(guest, 'ArrowDown');
    await waitFor(host, () => [1, 3].every(id => session.lines.find(line => line.id === id).character === 'Friend'));
    await guest.keyboard.down('Control'); await guest.keyboard.press('KeyZ'); await guest.keyboard.up('Control');
    await waitFor(host, () => [1, 3].every(id => session.lines.find(line => line.id === id).character === 'Hero'));
  });
  test('Add role, role rename and session rename use the app dialog, including cancellation', async () => {
    await edit();
    for (const page of [host, guest]) await page.evaluate(() => { window.prompt = () => { throw new Error('prompt() is not supported.'); }; });
    await guest.click('.track-add-btn'); await answerTextPrompt(guest, 'New role');
    await waitFor(host, () => session.trackOrder.includes('New role'));
    await waitFor(guest, () => document.querySelector('[data-character="New role"] .track-rename'));
    await guest.click('[data-character="New role"] .track-rename'); await answerTextPrompt(guest, 'Renamed role');
    await waitFor(host, () => session.trackOrder.includes('Renamed role') && !session.trackOrder.includes('New role'));
    await guest.locator('.track-add-btn').click(); await guest.keyboard.type('Cancelled'); await guest.keyboard.press('Escape');
    assert.equal(await guest.evaluate(() => !!document.querySelector('dialog[open]')), false);
    assert.equal(await guest.evaluate(() => session.trackOrder.includes('Cancelled')), false);
    await host.evaluate(() => { renameSession(session.activeSessionId); }); await answerTextPrompt(host, 'Renamed scene');
    await waitFor(guest, () => session.title === 'Renamed scene');
    assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []);
  });
  test('double-click creates exactly one line on the clicked track, selects it, supports Undo and reload', async () => {
    await edit(); await guest.click('#line-block-1'); await blankClick(guest, 'Friend', 1.25);
    const created = await waitFor(host, () => session.lines.find(line => line.id > 4));
    assert.equal(created.character, 'Friend'); assert.ok(Math.abs(created.start - 1.25) < 0.025);
    assert.equal(created.end - created.start, 2);
    await waitFor(guest, id => selectedLine?.id === id && !!document.getElementById('editorCaption'), 5000, created.id);
    assert.equal(await host.evaluate(() => session.lines.length), 5);
    await guest.evaluate(() => editorUndo()); await waitFor(host, () => session.lines.length === 4);
    await blankClick(guest, 'Friend', 1.25); await waitFor(host, () => session.lines.length === 5);
    await guest.reload(); await waitFor(guest, () => session?.lines.length === 5);
    assert.equal(await guest.evaluate(() => session.lines.find(line => line.id > 4).character), 'Friend');
  });
  test('double-click accounts for zoom and horizontal scrolling and never extends past video end', async () => {
    await edit(); await guest.click('.track-add-btn'); await answerTextPrompt(guest, 'Empty');
    await waitFor(guest, () => session.trackOrder.includes('Empty'));
    await guest.evaluate(async () => {
      setTimelineZoom(220, 0);
      // Zoom renders and restores its anchor on the next frame, before manual scroll.
      await new Promise(resolve => requestAnimationFrame(resolve));
      timelineContainer.scrollLeft = 900;
    });
    await blankClick(guest, 'Empty', 6);
    const created = await waitFor(host, () => session.lines.find(line => line.id > 4));
    assert.ok(Math.abs(created.start - 6) < 0.025, JSON.stringify(created));
    await guest.evaluate(() => { timelineContainer.scrollLeft = 2100; });
    await blankClick(guest, 'Empty', 11.98);
    const end = await waitFor(host, () => session.lines.find(line => line.id > 5));
    assert.equal(end.end, 12); assert.ok(end.end - end.start >= 0.0999);
  });
  test('double-click on a block, audio lane, label or in Dub Mode does not create a line', async () => {
    await edit();
    await guest.click('#line-block-1', { count: 2 });
    await guest.click('[data-character="Hero"] .char-name', { count: 2 });
    await guest.click('.studio-wave-area', { count: 2 });
    await wait(150); assert.equal(await guest.evaluate(() => session.lines.length), 4);
    await host.click('#dubModeBtn'); await waitFor(guest, () => session.mode === 'dub');
    await blankClick(guest, 'Friend', 1.25); await wait(150);
    assert.equal(await guest.evaluate(() => session.lines.length), 4);
  });
  test('all mixer sliders reach 150%, synchronize and persist; personal monitoring stays local', async () => {
    for (const id of ['volOriginal', 'volBacking', 'volRecorded']) {
      await host.focus(`#${id}`); await host.keyboard.press('End');
    }
    await waitFor(guest, () => ['original', 'backing', 'dub'].every(channel => session.projectAudio[channel].volume === 1.5));
    await host.reload(); await waitFor(host, () => session?.loaded && document.getElementById('volOriginal').value === '150');
    assert.equal(await host.evaluate(() => createExportSnapshot().gains.original), 1.5);
    await guest.select('[data-studio-mix]', 'monitor'); await guest.focus('#volOriginal'); await guest.keyboard.press('Home');
    assert.equal(await guest.$eval('#volOriginal', el => el.value), '0');
    assert.equal(await host.evaluate(() => session.projectAudio.original.volume), 1.5);
  });
  test('paused and playing prompter updates captions and roles without changing line IDs', async () => {
    await edit(); await guest.evaluate(() => { video.currentTime = 3.5; updatePrompter(); });
    await waitFor(guest, () => document.querySelector('.prompter-text'));
    const caption = 'Новая реплика '.repeat(50);
    const saved = await host.evaluate(caption => new Promise(resolve => socket.emit('editor_update_line', {
      lineId: 1, revision: 0, sessionId: session.activeSessionId, caption
    }, resolve)), caption);
    assert.equal(saved.ok, true);
    await waitFor(guest, caption => document.querySelector('[data-line="1"] .prompter-text')?.textContent === caption.trim(), 5000, caption);
    await guest.evaluate(() => video.play());
    await host.evaluate(() => updateEditorLine(session.lines.find(line => line.id === 1), { character: 'Friend' }));
    await waitFor(guest, () => document.querySelector('[data-line="1"] .prompter-char')?.textContent === 'Friend:');
    await guest.evaluate(() => video.pause());
  });
  test('a 600-character caption saves through the actual form and survives reload and restart', async () => {
    await edit(); await guest.click('#line-block-1'); const caption = 'Ж'.repeat(600);
    await guest.focus('#editorCaption'); await guest.keyboard.down('Control'); await guest.keyboard.press('KeyA'); await guest.keyboard.up('Control');
    await guest.keyboard.type(caption); await guest.click('#editorLineForm button[type="submit"]');
    await waitFor(host, caption => session.lines.find(line => line.id === 1).caption === caption, 5000, caption);
    await guest.reload(); await waitFor(guest, caption => session?.lines.find(line => line.id === 1).caption === caption, 5000, caption);
    await server.restart(); await waitFor(host, caption => socket.connected && session?.lines.find(line => line.id === 1).caption === caption, 20000, caption);
  });
  test('Escape closes settings and files while a text input has focus', async () => {
    await host.evaluate(() => openSettingsModal()); await host.focus('#settingsNickInput'); await host.keyboard.press('Escape');
    assert.equal(await host.$eval('#settingsModal', el => el.style.display), 'none');
    await host.evaluate(() => openFilesModal()); await host.focus('#workshopUrlInput'); await host.keyboard.press('Escape');
    assert.equal(await host.$eval('#filesModal', el => el.style.display), 'none');
  });
  test('switching background audio bypasses an old local blob in playback, P2P and rendered export', async () => {
    const zip = new AdmZip(fs.readFileSync(buildFixturePack())); zip.updateFile('dub_video.mp4', fs.readFileSync(buildMultiTrackVideo()));
    const file = path.join(server.dirs.packs, 'multi.zip'); zip.writeZip(file);
    await host.evaluate(() => loadSavedPack('multi.zip'));
    await waitFor(guest, () => session?.audioTracks?.length === 2 && Number.isFinite(video.duration));
    const input = await guest.$('#localMediaInput'); await input.uploadFile(file);
    await waitFor(guest, () => localMedia?.backingBlob && mediaUrl(session.backingUrl).startsWith('blob:'));
    const old = await guest.evaluate(() => localMedia.backingUrl);
    await host.evaluate(() => socket.emit('host_set_audio_tracks', { sessionId: session.activeSessionId,  original: 0, backing: 1 }));
    await waitFor(guest, () => session.backingTrack === 1 && backing.src.endsWith(session.backingUrl));
    const result = await guest.evaluate(async () => {
      const snapshot = createExportSnapshot();
      const rendered = await mixSoundtrack(1, { original: 0, backing: 1, dub: 0 }, () => {}, snapshot);
      const samples = rendered.getChannelData(0); let crossings = 0;
      for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
      return { media: mediaUrl(session.backingUrl), exportUrl: snapshot.backingUrl, shared: heldFiles().has(session.backingUrl), crossings };
    });
    assert.notEqual(result.media, old); assert.equal(result.exportUrl, result.media);
    assert.equal(result.shared, false); assert.ok(result.crossings > 830 && result.crossings < 930, JSON.stringify(result));
  });
  test('pending take adopts a confirmed rename, survives reload, and eventually uploads', async () => {
    await claimAndSelect(guest, 1);
    await guest.setRequestInterception(true);
    const handler = request => request.url().includes('/api/upload-line-audio') ? request.respond({ status: 502, body: '{}' }) : request.continue();
    guest.on('request', handler); await take(guest, 'rename-pending');
    await guest.evaluate(() => socket.emit('rename_user', { newName: 'Bobby' }));
    await waitFor(guest, () => myName === 'Bobby' && pendingTakes.get('rename-pending')?.nick === 'Bobby');
    await waitFor(guest, async () => (await takeStore.all()).find(entry => entry.uploadId === 'rename-pending')?.nick === 'Bobby');
    await guest.reload(); await waitFor(guest, () => myName === 'Bobby' && pendingTakes.has('rename-pending'));
    guest.off('request', handler); await guest.setRequestInterception(false); await guest.evaluate(() => retryPendingTakes());
    await waitFor(host, () => session.lines[0].recordedBy === 'Bobby');
    assert.equal(await guest.evaluate(() => pendingTakes.size), 0);
  });
  test('a nickname-not-confirmed response keeps the blob and retries with the new nickname', async () => {
    await claimAndSelect(guest, 1); await guest.setRequestInterception(true);
    let held = null;
    const handler = request => { if (request.url().includes('/api/upload-line-audio') && !held) held = request; else request.continue(); };
    guest.on('request', handler);
    await guest.evaluate(() => { window.heldTake = (async () => {
      const blob = await (await fetch(session.lines[0].originalAudioUrl)).blob();
      return submitTake({ uploadId: 'rename-flight', takeSequence: await reserveTake(1, session.activeSessionId), room: currentRoom, sessionId: session.activeSessionId, lineId: 1, nick: myName, audioStart: 0, blob });
    })(); });
    await waitFor(guest, () => pendingTakes.has('rename-flight'));
    await guest.evaluate(() => socket.emit('rename_user', { newName: 'Bobby' })); await waitFor(guest, () => myName === 'Bobby');
    while (!held) await wait(20);
    await held.respond({ status: 403, contentType: 'application/json', body: JSON.stringify({ key: 'error.nickNotConfirmed', error: 'Rejoin' }) });
    await guest.evaluate(() => window.heldTake);
    assert.equal(await guest.evaluate(() => pendingTakes.has('rename-flight')), true);
    guest.off('request', handler); await guest.setRequestInterception(false); await guest.evaluate(() => retryPendingTakes());
    await waitFor(host, () => session.lines[0].recordedBy === 'Bobby');
  });
  test('a late onstop submission cannot replace a newer queued take or its stored blob', async () => {
    await claimAndSelect(guest, 1); await guest.setRequestInterception(true);
    const handler = request => request.url().includes('/api/upload-line-audio') ? request.respond({ status: 502, body: '{}' }) : request.continue();
    guest.on('request', handler);
    const sequences = await guest.evaluate(async () => [await reserveTake(1, session.activeSessionId), await reserveTake(1, session.activeSessionId)]);
    await take(guest, 'newer', sequences[1]); await take(guest, 'older', sequences[0]);
    assert.deepEqual(await guest.evaluate(() => [...pendingTakes.keys()]), ['newer']);
    await waitFor(guest, async () => { const entries = await takeStore.all(); return entries.length === 1 && entries[0].uploadId === 'newer'; });
    guest.off('request', handler); await guest.setRequestInterception(false); await guest.evaluate(() => retryPendingTakes());
    await waitFor(host, () => session.lines[0].uploadId === 'newer');
  });
  for (const changed of ['scene', 'take']) test(`a delayed Delete button request preserves the new ${changed}`, async () => {
    await claimAndSelect(guest, 1); await take(guest, 'old-delete');
    await waitFor(guest, () => session.lines[0].uploadId === 'old-delete');
    await guest.setRequestInterception(true); let held;
    const handler = request => { if (request.url().endsWith('/api/delete-line-audio')) held = request; else request.continue(); };
    guest.on('request', handler);
    await guest.evaluate(() => { window.deleteResult = deleteLineAudio(1); });
    await waitUntil(() => !!held);
    if (changed === 'scene') {
      const oldId = await guest.evaluate(() => session.activeSessionId);
      await loadFixture(host); await waitFor(guest, oldId => session.activeSessionId !== oldId, 5000, oldId);
      await claimAndSelect(guest, 1);
    }
    await take(guest, 'new-delete'); await waitFor(guest, () => session.lines[0].uploadId === 'new-delete');
    const url = await guest.evaluate(() => session.lines[0].audioUrl);
    await held.continue(); await guest.evaluate(() => window.deleteResult);
    assert.equal(await guest.evaluate(() => session.lines[0].audioUrl), url);
    guest.off('request', handler); await guest.setRequestInterception(false);
  });
  test('an in-flight old upload arriving after a newer take cannot overwrite it', async () => {
    await claimAndSelect(guest, 1); await guest.setRequestInterception(true); let held;
    const handler = request => { if (request.url().includes('/api/upload-line-audio') && !held) held = request; else request.continue(); };
    guest.on('request', handler);
    await guest.evaluate(() => { window.oldUpload = (async () => {
      const sequence = await reserveTake(1, session.activeSessionId);
      const blob = await (await fetch(session.lines[0].originalAudioUrl)).blob();
      return submitTake({ uploadId: 'old-flight', takeSequence: sequence, room: currentRoom, sessionId: session.activeSessionId, lineId: 1, nick: myName, audioStart: 0, blob });
    })(); });
    await waitUntil(() => !!held); await take(guest, 'new-flight');
    await waitFor(host, () => session.lines[0].uploadId === 'new-flight');
    const url = await host.evaluate(() => session.lines[0].audioUrl);
    await held.continue(); await guest.evaluate(() => window.oldUpload);
    assert.equal(await host.evaluate(() => session.lines[0].audioUrl), url);
    assert.equal(await guest.evaluate(() => pendingTakes.size), 0);
    guest.off('request', handler); await guest.setRequestInterception(false);
  });
  test('renaming during actual MediaRecorder processing keeps the completed take', async () => {
    await claimAndSelect(guest, 1);
    await guest.evaluate(() => handleStudioRecord(1));
    await waitFor(guest, () => recordState === 'preparing' || recordState === 'recording'); await wait(300);
    await guest.evaluate(() => {
      const original = window.decodeAudio;
      window.decodeAudio = async data => {
        window.decodeAudio = original;
        window.analysisWaiting = true;
        await new Promise(resolve => { window.resumeAnalysis = resolve; });
        return original(data);
      };
      finishRecording();
    });
    await waitFor(guest, () => window.analysisWaiting);
    await guest.evaluate(() => socket.emit('rename_user', { newName: 'Bobby' }));
    await waitFor(guest, () => myName === 'Bobby'); await guest.evaluate(() => { window.resumeAnalysis(); });
    await waitFor(host, () => session.lines[0].recordedBy === 'Bobby');
    assert.equal(await guest.evaluate(() => pendingTakes.size), 0);
  });
  test('nudge and Reset shift preserve negative preparation audio at frame zero', async () => {
    await edit(); await host.evaluate(() => updateEditorLine(session.lines.find(line => line.id === 1), { start: 0, end: 1.5 }));
    await host.click('#dubModeBtn'); await waitFor(guest, () => session.mode === 'dub' && session.lines[0].start === 0);
    await claimAndSelect(guest, 1); await take(guest, 'negative-start', undefined, -3);
    await waitFor(guest, () => session.lines[0].audioStart === -3);
    await guest.locator('[onclick="nudgeTake(1, 0.05)"]').click();
    await waitFor(host, () => session.lines[0].audioStart === -2.95);
    // The host's acknowledgement can arrive before this client's inspector is rebuilt.
    // Wait for the enabled replacement button before the locator captures its element.
    await waitFor(guest, () => session.lines[0].audioStart === -2.95 &&
      document.querySelector('[onclick="resetTakeShift(1)"]')?.disabled === false);
    await guest.locator('[onclick="resetTakeShift(1)"]').click();
    await waitFor(host, () => session.lines[0].audioStart === -3);
    await guest.reload(); await waitFor(guest, () => session?.lines[0].audioStart === -3);
  });
  test('recording starts only after reconnection and does not request a microphone while offline', async () => {
    await claimAndSelect(guest, 1);
    await guest.evaluate(() => {
      window.microphoneRequests = 0;
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...args) => { window.microphoneRequests++; return original(...args); };
      socket.disconnect();
    });
    await guest.click('#recBtn');
    assert.equal(await guest.evaluate(() => window.microphoneRequests), 0);
    assert.equal(await guest.evaluate(() => recordState), 'idle');
    await guest.evaluate(() => socket.connect()); await waitFor(guest, () => socket.connected && myName === 'Bob');
    await guest.click('#recBtn'); await waitFor(guest, () => recordState === 'preparing' || recordState === 'recording');
    assert.equal(await guest.evaluate(() => window.microphoneRequests), 1);
    await guest.evaluate(() => finishRecording({ discard: true }));
  });
  test('prototype-like roles are shown as free, claimable and releasable in the real interface', async () => {
    await edit(); await guest.click('.track-add-btn'); await answerTextPrompt(guest, 'constructor');
    await waitFor(guest, () => session.trackOrder.includes('constructor'));
    await blankClick(guest, 'constructor', 1);
    await waitFor(guest, () => session.lines.some(line => line.character === 'constructor'));
    await host.click('#dubModeBtn'); await waitFor(guest, () => session.mode === 'dub');
    const id = await guest.evaluate(() => session.lines.find(line => line.character === 'constructor').id);
    await guest.click(`#line-block-${id}`);
    await guest.click('#inspector .btn-claim');
    await waitFor(host, id => session.lines.find(line => line.id === id).claimedBy === 'Bob', 5000, id);
    assert.deepEqual(guest.errors, []);
  });
});
