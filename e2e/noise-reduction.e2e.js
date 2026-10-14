const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor } = require('./helpers');
function runFfmpeg(args) { const result = require('node:child_process').spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (result.status) throw Error(String(result.stderr)); }
const { readProject } = require('../server/projects');
describe('profile noise reduction: real audio, private preview, scoped sockets and project roundtrip', { skip: skipReason, timeout: 240000 }, () => {
  let server, browser, host, guest, originalProfile;
  const scene = page => page.evaluate(() => structuredClone(session));
  const line = (page = guest, id = 1) => page.evaluate(id => structuredClone(session.lines.find(line => line.id === id)), id);
  async function update(page, payload) {
    const result = await page.evaluate(payload => new Promise(resolve => socket.emit('noise_update', {
      sessionId: session.activeSessionId, revision: session.noiseReduction?.revision || 0, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now(), ...payload
    }, resolve)), payload);
    if (result.ok) await waitFor(guest, revision => session.noiseReduction.revision === revision, 10000, result.noiseReduction.revision);
    return result;
  }
  async function upload(page = guest, id = 1, binding = null, seconds = .1) {
    return page.evaluate(async (id, binding, seconds) => {
      const sequence = await reserveTake(id, session.activeSessionId), buffer = new AudioBuffer({ length: Math.round(48000 * seconds), numberOfChannels: 1, sampleRate: 48000 });
      let random = 13; const pcm = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; pcm[i] = .03 * Math.sin(i * .1) + .005 * (random / 4294967296 * 2 - 1); }
      const form = new FormData();
      for (const [key, value] of Object.entries({ lineId: id, clientId, userName: myName, sessionId: session.activeSessionId, takeSequence: sequence, uploadId: newUploadId(), audioStart: 0, noiseProfileId: binding || '' })) form.append(key, value);
      form.append('audio', new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), 'take.wav');
      const response = await fetch('/api/upload-line-audio?room=' + currentRoom, { method: 'POST', body: form }); return { status: response.status, body: await response.json() };
    }, id, binding, seconds);
  }
  before(async () => {
    server = await startServer();
    const zipPath = path.join(server.dirs.packs, 'test-scene.zip'), zip = new AdmZip(zipPath), source = zip.getEntry('001.wav').getData();
    for (let id = 5; id <= 420; id++) { const name = String(id).padStart(3, '0'); zip.addFile(name + '.wav', source); zip.addFile(name + '.ini', Buffer.from(`caption = Synthetic cue ${id}\ndub_characters = ["Hero"]\ndub_timestamps = [0,1]\n`)); } zip.writeZip(zipPath);
    const mic = path.join(server.dirs.data, 'calibration.wav'); runFfmpeg(['-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.015:duration=60:seed=17', '-ar', '48000', '-ac', '1', mic]);
    browser = await launchBrowser(server.port, { fakeAudioFile: mic });
    host = await openPlayer(browser, server.url('noise'), 'Host'); guest = await openPlayer(browser, server.url('noise'), 'Actor', { noiseOfferSeen: false });
    await host.evaluate(() => loadSavedPack('test-scene.zip'));
    await waitFor(host, () => session?.lines.length === 420); await waitFor(guest, () => session?.lines.length === 420);
    await guest.evaluate(() => { noiseSuppression = false; userMicGain = 1; socket.emit('claim_character', { character: 'Hero', sessionId: session.activeSessionId }); });
    await waitFor(guest, () => session.characterClaims.Hero === myName);
    await host.evaluate(() => socket.emit('claim_character', { character: 'Friend', sessionId: session.activeSessionId }));
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('offer waits for permission, can be declined, and remains declined after reload', async () => {
    assert.equal(await guest.evaluate(() => noiseOffer.open), false);
    await guest.evaluate(async () => { const stream = await DublineAudioDevices.capture({ noiseSuppression: false }); stream.getTracks().forEach(track => track.stop()); DublineAudioDevices.release(stream); });
    await waitFor(guest, () => noiseOffer.open); await guest.click('#noiseOfferSkip');
    assert.equal(await guest.evaluate(() => JSON.parse(localStorage.getItem('dubline_noise_offer_seen'))), true);
    await guest.reload(); await waitFor(guest, () => session?.loaded && myName === 'Actor');
    assert.equal(await guest.evaluate(() => noiseOffer.open), false);
  });
  test('six-second calibration is voluntary, spectral and does not alter old takes', async () => {
    for (let id = 5; id < 15; id++) assert.equal((await upload(guest, id)).status, 200);
    const before = (await scene(guest)).lines;
    await guest.evaluate(() => { noiseSuppression = false; userMicGain = 1; DublineNoise.open(); });
    const started = Date.now(); await guest.click('#noiseCalibrate');
    await waitFor(guest, () => noiseStatus.textContent === t('noise.calibratedDraft'), 18000);
    assert.ok(Date.now() - started >= 5900); assert.deepEqual((await scene(guest)).lines, before);
    await guest.click('#noiseConfirm'); await waitFor(guest, () => session.noiseReduction?.actors.Actor?.enabled);
    originalProfile = (await scene(guest)).noiseReduction.actors.Actor.profileId;
    assert.equal((await scene(guest)).noiseReduction.profiles[originalProfile].power.length, 513);
    assert.equal((await scene(guest)).noiseReduction.actors.Actor.strength, .2); await guest.click('#noiseClose');
    for (let id = 15; id < 20; id++) assert.equal((await upload(guest, id, originalProfile)).status, 200);
    const all = (await scene(guest)).lines; assert.ok(all.filter(l => l.id >= 5 && l.id < 15).every(l => !l.noiseProfileId)); assert.ok(all.filter(l => l.id >= 15 && l.id < 20).every(l => l.noiseProfileId === originalProfile));
  });
  test('old take preview, A/B and moving strength never mutate room, history, video or other listener audio', async () => {
    assert.equal((await upload(guest, 1, null, 4)).status, 200); await waitFor(host, () => session.lines.find(l => l.id === 1).audioUrl);
    const before = await line(host); const videoTime = await guest.evaluate(() => video.currentTime);
    const hostAudio = await host.evaluate(async () => Array.from((await getProcessedTake(session.lines.find(l => l.id === 1))).getChannelData(0)));
    await host.evaluate(async () => { window.noiseTestPreviewEnded = false; await audio.previewTake(session.lines.find(l => l.id === 1), { onEnded: () => window.noiseTestPreviewEnded = true }); });
    await guest.evaluate(() => { DublineNoise.open(); noiseDialog.querySelector('details').open = true; noiseSample.value = `1:${session.lines.find(l => l.id === 1).takeId}`; noiseSample.dispatchEvent(new Event('change')); });
    await waitFor(guest, () => !noisePreviewPlay.disabled && noiseStatus.textContent === t('noise.previewOnly'));
    await guest.click('#noisePreviewPlay'); await waitFor(guest, () => DublineNoise.previewPosition() > .01);
    await guest.evaluate(() => { noiseStrength.value = 80; noiseStrength.dispatchEvent(new Event('input')); noiseAB.value = 'clean'; noiseAB.dispatchEvent(new Event('change')); });
    await waitFor(guest, () => noiseStatus.textContent === t('noise.previewOnly'));
    await guest.click('#noiseConfirm'); await waitFor(guest, () => session.noiseReduction.actors.Actor.strength === .8);
    // Confirming global strength does not enroll the test sample.
    assert.equal((await line()).noiseProfileId, null); await guest.click('#noiseClose');
    assert.equal(await host.evaluate(() => window.noiseTestPreviewEnded), false, 'an unassigned take keeps playing when its author confirms noise settings');
    await host.evaluate(() => audio.stopPreview());
    assert.deepEqual(await line(host), before); assert.equal(await guest.evaluate(() => video.currentTime), videoTime);
    assert.deepEqual(await host.evaluate(async () => Array.from((await getProcessedTake(session.lines.find(l => l.id === 1))).getChannelData(0))), hostAudio);
  });
  test('scratch phrase is local, stoppable, and released on close without uploads or scene changes', async () => {
    const before = await scene(guest); let uploads = 0; const inspect = request => { if (request.url().includes('/api/upload-line-audio')) uploads++; }; guest.on('request', inspect);
    await guest.evaluate(() => { DublineNoise.open(); noiseDialog.querySelector('details').open = true; });
    await guest.click('#noiseTestRecord'); await waitFor(guest, () => DublineNoise.busy() && !noiseTestRecord.disabled);
    await new Promise(resolve => setTimeout(resolve, 200)); await guest.click('#noiseTestRecord');
    await waitFor(guest, () => !DublineNoise.busy() && !noisePreviewPlay.disabled); await guest.click('#noiseClose');
    guest.off('request', inspect); assert.equal(uploads, 0); assert.deepEqual((await scene(guest)).lines, before.lines); assert.equal(await guest.evaluate(() => DublineAudioDevices.busy()), false);
  });
  test('selection and cancellation remain private; explicit selection applies only those variants', async () => {
    await guest.evaluate(() => { DublineNoise.open(); noiseDialog.querySelectorAll('details')[1].open = true; noiseSelect.click(); });
    await guest.evaluate(() => { noiseTakeList.querySelector('input[data-id^="5:"]').click(); noiseSelectionCancel.click(); });
    assert.equal((await line(guest, 5)).noiseProfileId, null);
    await guest.evaluate(() => { noiseSelect.click(); for (const id of [5, 6, 7, 8, 9]) noiseTakeList.querySelector(`input[data-id^="${id}:"]`).click(); noiseApplySelected.click(); });
    await waitFor(guest, () => session.lines.filter(l => l.id >= 5 && l.id <= 9).every(l => l.noiseProfileId));
    assert.ok((await scene(guest)).lines.filter(l => l.id >= 10 && l.id < 15).every(l => !l.noiseProfileId));
    await guest.evaluate(() => { noiseTakeList.querySelector('input[data-id^="5:"]').click(); noiseRemoveSelected.click(); });
    await waitFor(guest, () => !session.lines.find(l => l.id === 5).noiseProfileId); await guest.click('#noiseClose');
  });
  test('400-cue batch is lazy and author-only; raw asset hashes do not change', async () => {
    assert.equal((await upload(host, 2)).status, 200); const foreign = await line(host, 2);
    for (let id = 20; id < 105; id++) assert.equal((await upload(guest, id)).status, 200);
    const owned = (await scene(guest)).lines.filter(l => l.recordedBy === 'Actor'), hashes = new Map(owned.map(l => [l.audioUrl, crypto.createHash('sha256').update(fs.readFileSync(path.join(server.dirs.uploads, path.basename(l.audioUrl)))).digest('hex')]));
    await waitFor(guest, () => session.lines.filter(l => l.recordedBy === 'Actor').length >= 101 && !DublineNoiseAudio.stats().active && !DublineNoiseAudio.stats().queued);
    const stats = await guest.evaluate(() => DublineNoiseAudio.stats());
    await guest.evaluate(() => { DublineNoise.open(); noiseDialog.querySelectorAll('details')[1].open = true; noiseApplyAll.click(); });
    await waitFor(host, () => session.lines.filter(l => l.recordedBy === 'Actor').every(l => l.noiseProfileId)); await guest.click('#noiseClose');
    assert.deepEqual(await line(host, 2), foreign); assert.equal((await guest.evaluate(() => DublineNoiseAudio.stats())).completed, stats.completed);
    for (const [url, hash] of hashes) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(server.dirs.uploads, path.basename(url)))).digest('hex'), hash);
    const hostTake = (await scene(host)).lines.find(l => l.id === 2);
    assert.equal((await update(guest, { takes: [{ lineId: 2, takeId: hostTake.takeId, historyRevision: hostTake.takeHistoryRevision }], apply: true, profileId: originalProfile })).ok, false);
  });
  test('zero preparation records raw audio, freezes profile at capture start and Space saves exactly one take', async () => {
    const actor = (await scene(guest)).noiseReduction.actors.Actor;
    assert.equal((await update(guest, { actor: { ...actor, strength: 0 } })).ok, true);
    await guest.evaluate(() => { preRollSeconds = 0; localStorage.setItem('dubline_adr', 'off'); noiseSuppression = false; selectLine(session.lines.find(l => l.id === 106)); });
    await guest.keyboard.press('KeyR'); await waitFor(guest, () => recordState === 'recording', 10000);
    await guest.evaluate(() => { userMicGain = 1.2; });
    await guest.keyboard.press('Space');
    await waitFor(guest, () => recordState === 'idle' && session.lines.find(l => l.id === 106).audioUrl, 10000);
    const take = await line(guest, 106); assert.equal(take.noiseProfileId, originalProfile); assert.equal(take.takeHistory.length, 0);
    assert.equal(await guest.evaluate(() => DublineNoise.captureBinding(1, false, { getAudioTracks: () => [{ getSettings: () => ({ deviceId: 'different-physical-microphone' }) }] })), null);
    assert.equal(await guest.evaluate(() => DublineNoiseModel.resolve(session.lines.find(l => l.id === 106), session)), null);
    assert.equal((await update(guest, { actor })).ok, true);
    await guest.evaluate(() => { userMicGain = 1; });
  });
  test('worker cancellation frees the slot; cooperative fallback keeps the original buffer intact', async () => {
    const result = await guest.evaluate(async () => {
      const p = Object.values(session.noiseReduction.profiles)[0], pcm = new Float32Array(48000 * 60).fill(.001), abort = new AbortController();
      const pending = DublineNoiseAudio.run({ kind: 'clean', pcm, sampleRate: 48000, profile: p, strength: .8 }, abort.signal).then(() => 'done', e => e.name); abort.abort();
      const cancelled = await pending, WorkerClass = window.Worker;
      try { window.Worker = undefined; const raw = new AudioBuffer({ length: 4800, numberOfChannels: 1, sampleRate: 48000 }); raw.getChannelData(0).fill(.001); const buffer = await DublineNoiseAudio.clean(raw, { profile: p, strength: .5 }, null, true); return { cancelled, length: buffer.length, raw: raw.getChannelData(0)[0], active: DublineNoiseAudio.stats().active, fallback: DublineNoiseAudio.stats().fallback }; }
      finally { window.Worker = WorkerClass; }
    });
    assert.equal(result.cancelled, 'AbortError'); assert.equal(result.length, 4800); assert.ok(Math.abs(result.raw - .001) < 1e-8); assert.equal(result.active, false); assert.ok(result.fallback > 0);
  });
  test('all effects process after denoising, cache is reused, and stems share the same processed source', async () => {
    const checks = await guest.evaluate(async () => {
      const take = { ...session.lines.find(l => l.id === 15), start: 0, end: .1, audioStart: 0 };
      const results = [];
      for (const effect of Object.keys(DublineAudioFx.VOICE_EFFECTS)) {
        const l = { ...take, effect, pitch: 2, pitchMode: 'override' }, raw = await audio.getRawTake(l.audioUrl), setting = DublineNoiseModel.resolve(l, session);
        const expected = await DublineAudioFx.renderVoice(await DublineNoiseAudio.clean(raw, setting), effect, 2, takeDryBounds(l, raw.duration), 1);
        const actual = await getProcessedTake(l), second = await getProcessedTake(l);
        let error = 0; for (let i = 0; i < actual.length; i++) error = Math.max(error, Math.abs(actual.getChannelData(0)[i] - expected.getChannelData(0)[i]));
        results.push({ effect, error, cached: actual === second, finite: Array.from(actual.getChannelData(0)).every(Number.isFinite) });
      }
      const snapshot = createExportSnapshot(), exported = snapshot.takes.find(l => l.id === 15);
      const fromExport = await requireExportTake(exported); const normal = await getProcessedTake(take);
      const stem = await renderCharacterStem([exported], 1, 48000, snapshot);
      return { results, exportSame: fromExport === normal, stemChannels: stem.numberOfChannels, stemPeak: Math.max(...stem.getChannelData(0)) };
    });
    assert.ok(checks.results.every(r => r.error < 1e-6 && r.cached && r.finite), JSON.stringify(checks.results)); assert.equal(checks.exportSame, true); assert.equal(checks.stemChannels, 2); assert.ok(checks.stemPeak > 0);
  });
  test('recalibration cancellation preserves old profile; new version binds future takes only', async () => {
    const before = (await scene(guest)).noiseReduction;
    await guest.evaluate(() => DublineNoise.open()); await guest.click('#noiseCalibrate'); await waitFor(guest, () => DublineNoise.busy()); await guest.click('#noiseCaptureCancel'); await waitFor(guest, () => !DublineNoise.busy()); await guest.click('#noiseClose');
    assert.deepEqual((await scene(guest)).noiseReduction, before);
    const next = { ...before.profiles[originalProfile], id: crypto.randomUUID(), createdAt: Date.now() };
    assert.equal((await update(guest, { profile: next, actor: { ...before.actors.Actor, profileId: next.id } })).ok, true);
    assert.equal((await line(guest, 15)).noiseProfileId, originalProfile);
    assert.equal((await upload(guest, 1, next.id)).status, 200); await waitFor(guest, id => session.lines.find(l => l.id === 1).noiseProfileId === id, 10000, next.id);
    assert.equal((await line()).takeHistory[0].noiseProfileId, originalProfile);
  });
  test('restore retains binding, atomically rejected races do not enroll a replaced take, duplicate operations do not replay', async () => {
    const before = await line(), old = before.takeHistory[0];
    const result = await guest.evaluate(old => new Promise(resolve => socket.emit('take_history_update', { room: currentRoom, sessionId: session.activeSessionId, lineId: 1, takeId: old.id, action: 'restore', historyRevision: session.lines.find(l => l.id === 1).takeHistoryRevision, expectedOwner: getLineOwner(session.lines.find(l => l.id === 1)) }, resolve)), old);
    assert.equal(result.ok, true); await waitFor(guest, id => session.lines.find(l => l.id === 1).takeId === id, 10000, old.id); assert.equal((await line()).noiseProfileId, old.noiseProfileId);
    assert.equal((await update(guest, { takes: [{ lineId: 1, takeId: before.takeId, historyRevision: before.takeHistoryRevision }], apply: false })).reason, 'noise.conflict');
    const repeats = await guest.evaluate(async () => {
      const request = { sessionId: session.activeSessionId, revision: session.noiseReduction.revision, actor: { ...session.noiseReduction.actors.Actor, strength: .3 }, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() };
      const send = () => new Promise(resolve => socket.emit('noise_update', request, resolve)); return [await send(), await send()];
    }); assert.deepEqual(repeats[0], repeats[1]);
  });
  test('portable project v7 and server restart retain profiles and history with unchanged bytes', async () => {
    const before = await scene(guest);
    const bytes = await host.evaluate(async () => {
      const snapshot = await prepareSafeSnapshot('project');
      const response = await fetch('/api/export-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, ...snapshot }) }); if (!response.ok) throw Error(await response.text()); return Array.from(new Uint8Array(await response.arrayBuffer()));
    });
    const project = readProject(Buffer.from(bytes)); assert.equal(project.manifest.formatVersion, 7);
    assert.equal(Object.keys(project.manifest.project.noiseReduction.profiles).length, 2); assert.equal(project.manifest.project.lines.find(l => l.id === 1).takeHistory[0].noiseProfileId, before.lines.find(l => l.id === 1).takeHistory[0].noiseProfileId);
    await server.restart(); await waitFor(guest, () => socket.connected && session?.editorProtocol?.epoch, 15000);
    await waitFor(guest, count => Object.keys(session?.noiseReduction?.profiles || {}).length === count, 15000, 2);
    assert.deepEqual((await scene(guest)).noiseReduction, before.noiseReduction);
    const imported = await host.evaluate(async bytes => {
      const form = new FormData(); form.append('clientId', clientId); form.append('sessionId', session.activeSessionId);
      form.append('project', new Blob([new Uint8Array(bytes)]), 'noise.dubline');
      const response = await fetch('/api/import-project?room=' + currentRoom, { method: 'POST', body: form });
      if (!response.ok) throw Error(await response.text()); return (await response.json()).session.activeSessionId;
    }, bytes);
    await waitFor(guest, id => session.activeSessionId === id, 10000, imported);
    const reopened = await scene(guest); assert.deepEqual(reopened.noiseReduction.profiles, before.noiseReduction.profiles); assert.deepEqual(reopened.noiseReduction.actors, before.noiseReduction.actors);
    assert.equal(reopened.lines.find(l => l.id === 15).noiseProfileId, originalProfile); assert.equal(reopened.lines.find(l => l.id === 1).takeHistory.length, before.lines.find(l => l.id === 1).takeHistory.length);
  });
  test('all six themes, three languages and 150% zoom fit a narrow dialog without overflow', async () => {
    await guest.setViewport({ width: 800, height: 650 });
    for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
      const size = await guest.evaluate((theme, language) => { document.documentElement.dataset.theme = theme; DublineI18n.setLanguage(language); document.body.style.zoom = '1.5'; DublineNoise.open(); const dialog = noiseDialog; return { width: dialog.clientWidth, scroll: dialog.scrollWidth, outer: dialog.getBoundingClientRect().width, viewport: innerWidth, text: noiseTitle.textContent }; }, theme, language);
      assert.ok(size.scroll <= size.width + 1, `${theme}/${language}: ${JSON.stringify(size)}`); assert.ok(!size.text.startsWith('noise.')); await guest.evaluate(() => DublineNoise.close());
      assert.ok(size.outer < size.viewport, JSON.stringify(size));
    }
    await guest.evaluate(() => { document.body.style.zoom = ''; });
  });
  test('ordinary insecure HTTP can process saved takes without protected APIs or a second microphone capture', async () => {
    const httpBrowser = await launchBrowser(server.port, { secureOrigin: false });
    try {
      const page = await openPlayer(httpBrowser, server.url('noise', 'dubline.test'), 'HTTP Listener'); await waitFor(page, () => session?.loaded);
      const result = await page.evaluate(async () => {
        const take = session.lines.find(l => l.id === 15), buffer = await getProcessedTake(take);
        return { secure: isSecureContext, subtle: !!crypto.subtle, length: buffer?.length, profile: DublineNoiseModel.resolve(take, session)?.profile.id };
      });
      assert.equal(result.secure, false); assert.equal(result.subtle, false); assert.ok(result.length > 0); assert.equal(result.profile, originalProfile);
    } finally { await httpBrowser.close(); }
  });
  test('finished MP4 contains cleaned audio and exact source video packets without touching takes', async () => {
    const before = await line(guest, 15), outputs = await guest.evaluate(async () => {
      const snapshot = createExportSnapshot(); snapshot.takes = snapshot.takes.filter(line => line.id === 15);
      snapshot.gains.original = 0; snapshot.gains.backing = 0; snapshot.originalUrl = ''; snapshot.backingUrl = '';
      const rendered = await renderWithWebCodecs(() => {}, snapshot);
      snapshot.takes.forEach(line => line._exportNoise = null);
      const raw = await renderWithWebCodecs(() => {}, snapshot);
      return { cleaned: Array.from(new Uint8Array(await rendered.arrayBuffer())), raw: Array.from(new Uint8Array(await raw.arrayBuffer())), source: snapshot.videoUrl };
    });
    const cleanedPath = path.join(server.dirs.data, 'cleaned.mp4'), rawPath = path.join(server.dirs.data, 'raw.mp4');
    fs.writeFileSync(cleanedPath, Buffer.from(outputs.cleaned)); fs.writeFileSync(rawPath, Buffer.from(outputs.raw));
    const hash = (file, track, copy = false) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', track, ...(copy ? ['-c:v', 'copy'] : []), '-f', 'hash', '-hash', 'sha256', '-'];
      const result = require('node:child_process').spawnSync(require('ffmpeg-static'), args, { windowsHide: true, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    const source = path.join(server.dirs.uploads, outputs.source.slice('/uploads/'.length));
    assert.equal(hash(cleanedPath, '0:v:0', true), hash(source, '0:v:0', true)); assert.equal(hash(rawPath, '0:v:0', true), hash(source, '0:v:0', true));
    assert.notEqual(hash(cleanedPath, '0:a:0'), hash(rawPath, '0:a:0')); assert.deepEqual(await line(guest, 15), before);
  });
  test('host and guest have no unhandled errors after calibration, preview, recording and project reopen', () => {
    assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []);
  });
  test('a calibrated microphone and common strength carry into a fresh scene without recording or enrolling existing takes', async () => {
    const before = await scene(guest), saved = await guest.evaluate(() => JSON.parse(localStorage.getItem('dubline_noise_profile')));
    await host.evaluate(() => loadSavedPack('test-scene.zip'));
    await waitFor(guest, id => session.activeSessionId !== id && !!session.noiseReduction?.actors.Actor, 10000, before.activeSessionId);
    const next = await scene(guest); assert.equal(next.noiseReduction.actors.Actor.profileId, saved.profile.id); assert.equal(next.noiseReduction.actors.Actor.strength, saved.strength);
    assert.ok(next.lines.every(line => !line.noiseProfileId)); assert.equal(await guest.evaluate(() => DublineAudioDevices.busy()), false);
    const previous = JSON.parse(fs.readFileSync(path.join(server.dirs.data, 'rooms.json'), 'utf8')).noise.sessions[before.activeSessionId];
    assert.deepEqual(previous.noiseReduction, before.noiseReduction);
  });
});
