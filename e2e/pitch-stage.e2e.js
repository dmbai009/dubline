const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor, answerTextPrompt } = require('./helpers');

describe('Pitch as an ordered effect stage', { skip: skipReason }, () => {
  let server, browser, host, guest;
  const mutation = (page, event, data) => page.evaluate((event, data) => new Promise(resolve => socket.emit(event, { ...data, sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() }, resolve)), event, data);
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url('pitch-stage'), 'Host', { autoConfirm: false }); await loadFixture(host); await claimAndSelect(host, 1);
    guest = await openPlayer(browser, server.url('pitch-stage'), 'Guest'); await waitFor(guest, () => session.loaded);
    await host.evaluate(async () => {
      const buffer = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 });
      for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = .08 * Math.sin(2 * Math.PI * 440 * i / 48000);
      await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: 1, nick: myName, audioStart: 0, duration: 1, trimStart: .1, trimEnd: .9, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() });
    });
    await waitFor(host, () => !!session.lines[0].audioUrl);
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('pitch shifts at its actual position, preserves duration and bypasses at zero or disabled', async () => {
    const result = await host.evaluate(async () => {
      const input = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 });
      for (let i = 0; i < input.length; i++) input.getChannelData(0)[i] = .08 * Math.sin(2 * Math.PI * 440 * i / 48000);
      const pitch = { id: 'pitch', type: 'pitch', enabled: true, amount: 1, parameters: { semitones: 12 } }, radio = { id: 'radio', type: 'radio', enabled: true, amount: .8, parameters: {} };
      const run = effects => DublineAudioFx.renderChain(input, { pitch: 0, effects });
      const difference = (a, b) => a.getChannelData(0).reduce((sum, value, i) => sum + Math.abs(value - (b.getChannelData(0)[i] || 0)), 0);
      const up = await run([pitch]), down = await run([{ ...pitch, parameters: { semitones: -12 } }]);
      const frequency = b => { const values = b.getChannelData(0); let crossings = 0; for (let i = 12001; i < 36000; i++) if (values[i - 1] <= 0 && values[i] > 0) crossings++; return crossings * 2; };
      return { up: frequency(up), down: frequency(down), length: up.length, zero: difference(input, await run([{ ...pitch, parameters: { semitones: 0 } }])), disabled: difference(input, await run([{ ...pitch, enabled: false }])), order: difference(await run([pitch, radio]), await run([radio, pitch])) };
    });
    assert.ok(Math.abs(result.up - 880) < 20, JSON.stringify(result)); assert.ok(Math.abs(result.down - 220) < 20, JSON.stringify(result));
    assert.equal(result.length, 48000); assert.equal(result.zero, 0); assert.equal(result.disabled, 0); assert.ok(result.order > 1);
  });
  test('one pitch card replaces the former header, reorders, saves and synchronizes without changing original bytes', async () => {
    const original = await host.evaluate(async () => ({ bytes: [...new Uint8Array(await (await fetch(session.lines[0].audioUrl)).arrayBuffer())], trim: session.lines[0].trimStart }));
    await host.evaluate(() => DublineVoiceEditor.open(1, 'takes'));
    assert.equal(await host.$('#fxPitch'), null); assert.equal(await host.$('#fxPitchMode'), null); assert.equal(await host.$('#fxPresetIncludePitch'), null);
    await host.click('[data-fx-type=radio]'); await host.click('[data-fx-type=pitch]');
    await host.$eval('[data-action=semitones]', node => { node.value = '-7'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await host.$eval('[data-action=semitones]', node => node.min + ':' + node.max), '-12:12');
    await host.click('#fxRows .fx-item:last-child [data-action=up]');
    assert.deepEqual(await host.$$eval('#fxRows .fx-item b', nodes => nodes.map(node => node.textContent)), ['Pitch', 'Radio']);
    await host.click('#fxApply'); await waitFor(guest, () => session.lines[0].effects?.[0]?.type === 'pitch');
    assert.deepEqual(await host.evaluate(() => session.lines[0].effects.map(item => item.type)), ['pitch', 'radio']);
    assert.equal(await host.evaluate(() => session.lines[0].effects[0].parameters.semitones), -7);
    assert.equal(await host.evaluate(() => session.lines[0].pitch), 0);
    assert.deepEqual(await host.evaluate(async () => [...new Uint8Array(await (await fetch(session.lines[0].audioUrl)).arrayBuffer())]), original.bytes);
    assert.equal(await host.evaluate(() => session.lines[0].trimStart), original.trim);
  });
  test('preset creation, private edits and role inheritance retain the pitch stage and existing permissions', async () => {
    await host.evaluate(() => DublineVoiceEditor.open(1, 'takes')); await host.click('#fxPresetSave'); await answerTextPrompt(host, 'Pitch voice');
    await waitFor(guest, () => Object.values(session.voicePresets).some(p => p.name === 'Pitch voice'));
    const id = await host.evaluate(() => Object.values(session.voicePresets).find(p => p.name === 'Pitch voice').id);
    await host.click('#fxApply'); await waitFor(host, () => !fxDialog.open);
    await host.evaluate(() => DublineVoiceEditor.open(1, 'takes'));
    await host.$eval('[data-action=semitones]', node => { node.value = '5'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await host.click('#fxApply'); await waitFor(guest, () => session.lines[0].presetModified && session.lines[0].effects[0].parameters.semitones === 5);
    assert.equal(await guest.evaluate(id => session.voicePresets[id].effects[0].parameters.semitones, id), -7);
    const role = { scope: 'role', character: 'Hero', revision: 0, presetRevision: 1, rolePreset: { id:'hero-source', revision:0 }, settings: { pitch: 0, effects: [], voicePresetId: id, usePresetPitch: true, presetModified: false } };
    assert.equal((await mutation(guest, 'voice_update', role)).reason, 'fx.owner'); assert.equal((await mutation(host, 'voice_update', role)).ok, true);
    await waitFor(guest, () => !!session.roleEffects.Hero?.voicePresetId);
    assert.deepEqual(await guest.evaluate(() => DublineVoiceChain.resolve(session.lines[0], session).effects.filter(e => e.type === 'pitch').map(e => e.parameters.semitones)), [-7, 5]);
    await host.evaluate(() => DublineVoiceEditor.open(1, 'takes')); await host.click('#fxInheritRow'); await host.click('#fxApply');
    await waitFor(guest, () => !session.lines[0].inheritRoleEffects);
    assert.deepEqual(await guest.evaluate(() => DublineVoiceChain.resolve(session.lines[0], session).effects.filter(e => e.type === 'pitch').map(e => e.parameters.semitones)), [5]);
  });
  test('restart retains pitch stages and refuses older clients before room admission', async () => {
    await server.restart(); await waitFor(host, () => socket.connected && session.lines[0].effects?.[0]?.parameters.semitones === 5);
    const old = await openPlayer(browser, server.url('pitch-stage'), 'Old client', { beforeLoad: page => page.evaluateOnNewDocument(() => document.addEventListener('DOMContentLoaded', () => { window.denied = null; socket.on('join_denied', data => { denied = data; }); const emit = socket.emit; socket.emit = function(event, ...args) { if (event === 'join_room') args[0].voiceVersion = 3; return emit.call(this, event, ...args); }; }, { once: true })) });
    try { await waitFor(old, () => denied?.reason === 'voiceVersion'); assert.equal(await old.evaluate(() => hasSceneMediaAccess()), false); } finally { await old.browserContext().close(); }
    assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []);
  });
  test('opening and saving legacy pitch keeps its sound; editing the card converts it once', async () => {
    const request = await host.evaluate(() => {
      const line = session.lines[0]; return { scope: 'takes', action: 'replace', pitch: 3, editPitch: true, editPreset: true, settings: { effects: [{ id: 'legacy-radio', type: 'radio', enabled: true, amount: .4, parameters: {} }], pitchMode: 'override', inheritRoleEffects: false, excludedRoleEffectIds: [], voicePresetId: null, usePresetPitch: false, presetModified: true }, takes: [{ lineId: line.id, character: line.character, audioUrl: line.audioUrl, takeId: line.takeId, takeMixRevision: line.takeMixRevision, presetRevision: session.voicePresets[line.voicePresetId]?.revision }] };
    });
    assert.equal((await mutation(host, 'voice_update', request)).ok, true);
    await host.evaluate(async () => { window.legacySound = await audio.getProcessedTake(session.lines[0], { strict: true }); window.legacyKey = DublineVoiceChain.key(DublineVoiceChain.resolve(session.lines[0], session)); DublineVoiceEditor.open(1, 'takes'); });
    assert.equal(await host.$eval('[data-action=semitones]', node => node.value), '3');
    assert.equal(await host.evaluate(() => DublineVoiceEditor.dirty()), false);
    await host.click('#fxApply'); await waitFor(host, () => !fxDialog.open);
    assert.equal(await host.evaluate(async () => legacySound === await audio.getProcessedTake(session.lines[0], { strict: true }) && legacyKey === DublineVoiceChain.key(DublineVoiceChain.resolve(session.lines[0], session))), true);
    await host.evaluate(() => DublineVoiceEditor.open(1, 'takes'));
    await host.$eval('[data-action=semitones]', node => { node.value = '-4'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await host.click('#fxApply'); await waitFor(guest, () => session.lines[0].pitch === 0 && session.lines[0].effects[0]?.parameters?.semitones === -4);
    assert.equal(await host.evaluate(() => session.lines[0].effects.filter(e => e.type === 'pitch').length), 1);
  });
  test('inspector quick assignment replaces old scalar pitch with the selected pitch chain', async () => {
    const legacy = await host.evaluate(() => { const line = session.lines[0]; return { scope: 'takes', action: 'replace', pitch: 5, editPitch: true, editPreset: true, settings: { ...DublineVoiceChain.take(line), effects: [], voicePresetId: null, usePresetPitch: false, presetModified: true, pitchMode: 'override' }, takes: [{ lineId: line.id, character: line.character, audioUrl: line.audioUrl, takeId: line.takeId, takeMixRevision: line.takeMixRevision, presetRevision: session.voicePresets[line.voicePresetId]?.revision }] }; });
    assert.equal((await mutation(host, 'voice_update', legacy)).ok, true);
    const preset = { id: 'quick-pitch', name: 'Quick Pitch', revision: 0, action: 'create', settings: { effects: [{ id: 'quick-stage', type: 'pitch', enabled: true, amount: 1, parameters: { semitones: 7 } }] } };
    assert.equal((await mutation(host, 'voice_preset_update', preset)).ok, true);
    await host.evaluate(() => selectLine(session.lines[0])); await host.select('#inspectorPreset', 'quick-pitch'); await host.click('[data-preset-apply]');
    await waitFor(host, () => textPrompt.open); await host.click('#textPromptSave');
    await waitFor(guest, () => session.lines[0].voicePresetId === 'quick-pitch');
    assert.deepEqual(await host.evaluate(() => { const config = DublineVoiceChain.resolve(session.lines[0], session); return { pitch: config.pitch, stages: config.effects.map(e => e.parameters.semitones) }; }), { pitch: 0, stages: [7] });
  });
});
