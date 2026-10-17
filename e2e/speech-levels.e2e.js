const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor } = require('./helpers');
describe('optional voice levels and private recording checks', { skip: skipReason, timeout: 180000 }, () => {
  let server, browser, host, actor;
  async function record(amplitude, quality = false) {
    await claimAndSelect(actor, 2);
    await actor.evaluate(async (amplitude, quality) => {
      const pcm = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 });
      for (let i = 0; i < pcm.length; i++) pcm.getChannelData(0)[i] = Math.max(-1, Math.min(1, amplitude * Math.sin(2 * Math.PI * 997 * i / pcm.sampleRate)));
      const report = quality ? await DublineSpeechAnalysis.measure(pcm, {}, 'quality') : null;
      await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: 2, nick: myName, duration: 1, audioStart: 0, trimStart: .1, trimEnd: .9, quality: report, blob: new Blob([audioBufferToWav(pcm)], { type: 'audio/wav' }), createdAt: Date.now() });
    }, amplitude, quality);
    await waitFor(actor, () => !pendingTakeLines.size && !!session.lines.find(line => line.id === 2).audioUrl);
  }
  const levels = (page, value, revision) => page.evaluate((value, revision) => queueEditorRequest(() => ['project_audio_update', { channel: 'settings', field: 'normalizeVoices', value, revision: revision ?? session.projectAudio.revision }]), value, revision);
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); host = await openPlayer(browser, server.url('speech-levels'), 'Host'); actor = await openPlayer(browser, server.url('speech-levels'), 'Actor'); await loadFixture(host); await waitFor(actor, () => session.loaded); await record(.025); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('both optional controls start off and a participant cannot change the shared setting', async () => {
    assert.equal(await host.evaluate(() => session.projectAudio.normalizeVoices), false);
    assert.equal(await actor.$eval('#qualityCheckEnabled', node => node.checked), false);
    assert.equal((await levels(actor, true)).reason, 'host');
    assert.equal((await levels(host, true)).ok, true); await waitFor(actor, () => session.projectAudio.normalizeVoices);
    const revision = await host.evaluate(() => session.projectAudio.revision); assert.equal((await levels(host, false, revision - 1)).reason, 'conflict'); await host.evaluate(() => resolveEditorConflicts('discard', [...editorConflicts]));
  });
  test('levels preserve PCM and manual gain, share the measured gain with export, and cache the analysis', async () => {
    const result = await actor.evaluate(async () => {
      const take = { ...session.lines.find(line => line.id === 2), volume: .37, pan: -.2 }, before = DublineSpeechAnalysis.stats();
      const plain = await audio.prepareTake({ ...take, _exportLevel: false }), leveled = await audio.prepareTake(take), after = DublineSpeechAnalysis.stats();
      const snapshot = createExportSnapshot(), frozen = snapshot.takes.find(line => line.id === 2); await requireExportTake(frozen);
      const context = new OfflineAudioContext(2, plain.buffer.length, plain.buffer.sampleRate), source = context.createBufferSource(); source.buffer = plain.buffer;
      const graph = DublineAudioFx.connectTake(context, source, context.destination, { ...take, _levelGain: leveled.gain });
      return { same: plain.buffer === leveled.buffer, plain: plain.gain, gain: leveled.gain, exportGain: frozen._levelGain, manual: graph.gain.gain.value, scale: graph.scale, pan: graph.panner.pan.value, jobs: after.completed - before.completed, finalJobs: DublineSpeechAnalysis.stats().completed - after.completed, savedVolume: take.volume };
    });
    assert.ok(result.same); assert.equal(result.plain, 1); assert.ok(result.gain > 1 && result.gain <= 2); assert.ok(Math.abs(result.exportGain - result.gain) < 1e-9); assert.ok(Math.abs(result.manual - .37 * result.scale) < 1e-6); assert.ok(Math.abs(result.pan + .2) < 1e-6); assert.equal(result.savedVolume, .37); assert.ok(result.jobs <= 1); assert.equal(result.finalJobs, 0);
  });
  test('actual rendered stem PCM uses the same correction without touching raw audio', async () => {
    const result = await actor.evaluate(async () => {
      const snapshot = createExportSnapshot(), take = snapshot.takes.find(line => line.id === 2), plain = { ...take, _exportLevel: false }, leveled = { ...take, _exportLevel: true }, raw = await audio.getRawTake(take.audioUrl), saved = raw.getChannelData(0).slice();
      const off = await renderCharacterStem([plain], 1.5, 48000, snapshot), on = await renderCharacterStem([leveled], 1.5, 48000, snapshot), energy = buffer => buffer.getChannelData(0).reduce((sum, value) => sum + value * value, 0);
      return { ratio: Math.sqrt(energy(on) / energy(off)), gain: (await audio.prepareTake(leveled)).gain, unchanged: saved.every((value, i) => value === raw.getChannelData(0)[i]) };
    }); assert.ok(Math.abs(result.ratio - result.gain) < .002, JSON.stringify(result)); assert.ok(result.unchanged);
  });
  test('a short selection in a long stereo take transfers only its audible PCM bounds', async () => {
    const result = await actor.evaluate(async () => {
      const buffer = new AudioBuffer({ length: 48000 * 100, sampleRate: 48000, numberOfChannels: 2 }), bounds = { from: 49.95, to: 50.95 };
      for (let channel = 0; channel < 2; channel++) for (let i = Math.round(bounds.from * 48000); i < Math.round(bounds.to * 48000); i++) buffer.getChannelData(channel)[i] = .025 * Math.sin(2 * Math.PI * 997 * i / 48000);
      const promise = DublineSpeechAnalysis.measure(buffer, bounds), bytes = DublineSpeechAnalysis.stats().bytes, measured = await promise, reference = DublineSpeechModel.level([buffer.getChannelData(0), buffer.getChannelData(1)], 48000, bounds);
      return { bytes, expected: 48000 * 2 * 4, difference: Math.abs(measured.lufs - reference.lufs), duration: measured.duration };
    }); assert.equal(result.bytes, result.expected); assert.ok(result.difference < 1e-8); assert.equal(result.duration, 1);
  });
  test('a frozen export retains its level choice while the shared scene changes', async () => {
    await actor.evaluate(() => { window.levelSnapshot = createExportSnapshot(); }); assert.equal((await levels(host, false)).ok, true); await waitFor(actor, () => !session.projectAudio.normalizeVoices);
    const values = await actor.evaluate(async () => { const frozen = levelSnapshot.takes.find(line => line.id === 2); await requireExportTake(frozen); return [(await audio.prepareTake(session.lines.find(line => line.id === 2))).gain, frozen._levelGain]; }); assert.equal(values[0], 1); assert.ok(values[1] > 1);
  });
  test('a delayed live correction uses the latest confirmed manual volume', async () => {
    await actor.evaluate(async () => { const connect = DublineAudioFx.connectTake; window.restoreLevelGraph = () => { DublineAudioFx.connectTake = connect; }; DublineAudioFx.connectTake = (...args) => { const graph = connect(...args); window.liveLevelGraph = graph; return graph; }; await audio.previewTake(session.lines.find(line => line.id === 2)); const measure = DublineSpeechAnalysis.measure; window.restoreLevelMeasure = () => { DublineSpeechAnalysis.measure = measure; }; let held = false; DublineSpeechAnalysis.measure = (...args) => { if (held) return measure(...args); held = true; return new Promise(resolve => { window.releaseLevelMeasurement = () => measure(...args).then(resolve); }); }; });
    try { assert.equal((await levels(host, true)).ok, true); await waitFor(actor, () => typeof releaseLevelMeasurement === 'function');
      assert.equal((await actor.evaluate(() => new Promise(resolve => { const line = session.lines.find(line => line.id === 2); socket.emit('set_takes_props', { sessionId: session.activeSessionId, takes: [{ lineId: 2, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision || 0 }], props: { volume: .61 }, }, resolve); }))).ok, true);
      await actor.evaluate(() => releaseLevelMeasurement()); await waitFor(actor, () => liveLevelGraph.levelEnabled === true && Math.abs(liveLevelGraph.gain.gain.value - .61 * liveLevelGraph.scale) < .001); const gain = await actor.evaluate(() => ({ actual: liveLevelGraph.gain.gain.value, expected: .61 * liveLevelGraph.scale })); assert.ok(Math.abs(gain.actual - gain.expected) < .001, JSON.stringify(gain));
    } finally { await actor.evaluate(() => { restoreLevelGraph(); restoreLevelMeasure(); audio.stopPreview(); }); assert.equal((await levels(host, false)).ok, true); }
  });
  test('checks persist under immutable take IDs without appearing in public snapshots or marking retakes', async () => {
    await record(1.3, true); await actor.evaluate(() => DublineSceneReview.checkFiles()); await waitFor(actor, () => DublineTakeAnalysis.known(session.lines.find(line => line.id === 2))?.warnings.includes('clipped'));
    const result = await host.evaluate(() => ({ private: Object.hasOwn(session, 'takeChecks'), inline: session.lines.some(line => Object.hasOwn(line, 'quality')), retake: session.lines.find(line => line.id === 2).needsRetake })); assert.equal(result.private, false); assert.equal(result.inline, false); assert.ok(!result.retake);
    await host.evaluate(() => socket.emit('set_blind_mode', { sessionId: session.activeSessionId, enabled: true })); await waitFor(host, () => session.blindMode);
    const hidden = await host.evaluate(async () => (await fetch('/api/scene-review?' + new URLSearchParams({ room: currentRoom, clientId, sessionId: session.activeSessionId }))).json()); assert.equal(hidden.takes.length, 0);
    await host.evaluate(() => socket.emit('set_blind_mode', { sessionId: session.activeSessionId, enabled: false })); await waitFor(host, () => !session.blindMode);
  });
  test('an advisory warning can be ignored and does not change the recording', async () => {
    await actor.evaluate(() => showInspector(selectedLine)); const before = await actor.evaluate(() => JSON.stringify(session.lines.find(line => line.id === 2))); await actor.click('[data-quality-ignore]'); assert.equal(await actor.$('[data-quality-ignore]'), null); assert.equal(await actor.evaluate(() => JSON.stringify(session.lines.find(line => line.id === 2))), before);
  });
  test('portable version 11 preserves shared levels and private quality through explicit fields', async () => {
    assert.equal((await levels(host, true)).ok, true);
    const bytes = await host.evaluate(async () => { const barrier = await prepareSafeSnapshot('project'); const response = await fetch('/api/export-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, ...barrier }) }); if (!response.ok) throw Error(await response.text()); return [...new Uint8Array(await response.arrayBuffer())]; });
    const project = require('../src/server/projects').readProject(Buffer.from(bytes)); assert.equal(project.manifest.formatVersion, 11); assert.equal(project.manifest.project.mix.normalizeVoices, true); assert.ok(project.manifest.project.lines.find(line => line.id === 2).take.quality.warnings.includes('clipped'));
  });
  test('strict disk failure leaves the shared flag and revision unchanged', async () => {
    const before = await host.evaluate(() => structuredClone(session.projectAudio)), blocker = path.join(server.dirs.data, 'rooms.json.tmp'); assert.ok(blocker.startsWith(server.dirs.data + path.sep)); fs.mkdirSync(blocker);
    try { const result = await host.evaluate(() => new Promise(resolve => socket.emit('project_audio_update', { sessionId: session.activeSessionId, channel: 'settings', field: 'normalizeVoices', value: false, revision: session.projectAudio.revision }, resolve))); assert.equal(result.reason, 'storage'); assert.deepEqual(await host.evaluate(() => session.projectAudio), before); } finally { fs.rmdirSync(blocker); }
  });
  test('a lost acknowledgement is recovered once and the shared revision is not duplicated', async () => {
    const revision = await host.evaluate(() => session.projectAudio.revision);
    const result = await host.evaluate(async () => {
      const original = socket.emit, onack = socket.onack; let dropped = false; const packets = new Set(); socket.emit = function(event, ...args) { if (event === 'project_audio_update' && !dropped) { dropped = true; packets.add(this.ids); } return original.call(this, event, ...args); }; socket.onack = function(packet) { if (packets.delete(packet.id)) return; return onack.call(this, packet); };
      try { return await queueEditorRequest(() => ['project_audio_update', { channel: 'settings', field: 'normalizeVoices', value: false, revision: session.projectAudio.revision }]); } finally { socket.emit = original; socket.onack = onack; }
    }); assert.equal(result.ok, true); assert.equal(await host.evaluate(() => session.projectAudio.revision), revision + 1); await waitFor(actor, () => !session.projectAudio.normalizeVoices);
  });
  test('private checks survive a host restart', async () => {
    const takeId = await actor.evaluate(() => session.lines.find(line => line.id === 2).takeId), epoch = await host.evaluate(() => session.editorProtocol.epoch); await server.restart(); for (const page of [host, actor]) await waitFor(page, epoch => socket.connected && hasSceneMediaAccess() && session.editorProtocol.epoch !== epoch, 20000, epoch); await actor.evaluate(() => DublineSceneReview.checkFiles());
    assert.ok(await actor.evaluate(() => DublineTakeAnalysis.known(session.lines.find(line => line.id === 2))?.warnings.includes('clipped') || document.querySelector('.quality-hint') === null));
    const response = await actor.evaluate(async () => (await fetch('/api/scene-review?' + new URLSearchParams({ room: currentRoom, clientId, sessionId: session.activeSessionId }))).json()); assert.ok(response.takes.find(take => take.takeId === takeId)?.quality.warnings.includes('clipped'));
  });
  test('older clients remain usable in a legacy scene and are refused before shared processing can diverge', async () => {
    const beforeLoad = page => page.evaluateOnNewDocument(() => { document.addEventListener('DOMContentLoaded', () => { const emit = socket.emit; socket.emit = function(event, ...args) { if (event === 'join_room') delete args[0].voiceVersion; return emit.call(this, event, ...args); }; }, { once: true }); });
    const old = await openPlayer(browser, server.url('speech-levels'), 'Older client', { beforeLoad });
    try { await waitFor(old, () => session.loaded && hasSceneMediaAccess()); assert.equal((await levels(host, true)).reason, 'fx.clientUpdate'); assert.equal(await host.evaluate(() => session.projectAudio.normalizeVoices), false); }
    finally { await old.browserContext().close(); }
    await waitFor(host, () => !lastOnlineUsers.includes('Older client')); assert.equal((await levels(host, true)).ok, true);
    const denied = await openPlayer(browser, server.url('speech-levels'), 'Unsupported client', { beforeLoad });
    try { await waitFor(denied, () => deniedModal.style.display === 'flex'); assert.ok(!await denied.evaluate(() => hasSceneMediaAccess())); }
    finally { await denied.browserContext().close(); }
  });
  test('a confirmed disk failure stays visible and can be retried explicitly from the original journal', async () => {
    const blocker = path.join(server.dirs.data, 'rooms.json.tmp'); assert.ok(blocker.startsWith(server.dirs.data + path.sep)); fs.mkdirSync(blocker);
    try { await host.evaluate(async () => { openSettingsModal(); await switchSettingsTab('player'); await openSettingsCategory('player', 'audio'); }); await host.click('#normalizeVoices + .switch-slider'); await waitFor(host, () => editorConflicts.some(operation => operation.event === 'project_audio_update' && operation.outcome?.reason === 'storage'));
      assert.ok(await host.evaluate(() => editorConflicts.filter(operation => operation.event === 'project_audio_update').every(operation => operation.outcome.confirmed && canRetryEditorSave(operation)))); assert.equal(await host.$eval('#levelStatus', node => node.textContent), await host.evaluate(() => t('editor.failure.storage'))); assert.equal(await host.evaluate(() => session.projectAudio.normalizeVoices), true);
    } finally { fs.rmdirSync(blocker); }
    await host.evaluate(() => { closeSettingsModal(); reviewEditorConflicts(); }); await host.click('[data-retry-operation]'); await waitFor(host, () => !editorConflicts.length && !editorQueue.length && !session.projectAudio.normalizeVoices); assert.equal(await host.$eval('#levelStatus', node => node.textContent), await host.evaluate(() => t('level.saved'))); await host.evaluate(() => closeEditorConflicts());
  });
  test('no unhandled errors', () => { assert.deepEqual(host.errors, []); assert.deepEqual(actor.errors, []); });
});
