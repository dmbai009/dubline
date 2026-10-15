const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor, answerTextPrompt } = require('./helpers');
const effect = (id, type = 'telephone', amount = .8) => ({ id, type, enabled: true, amount, parameters: {} });
describe('live scene presets: confirmed multi-user sound, drafts, history and projects', { skip: skipReason, timeout: 240000 }, () => {
  let server, browser, host, actor, other, priorBuffer, untouchedBuffer, rawBuffer, wetCount, frozenKey, snapshot, originalHash;
  const call = (page, event, data) => page.evaluate((event, data) => new Promise(resolve => socket.emit(event, { sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now(), ...data }, resolve)), event, data);
  const close = page => page.evaluate(() => DublineVoiceEditor.close(true));
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url('live'), 'Host', { autoConfirm: false }); actor = await openPlayer(browser, server.url('live'), 'Actor', { autoConfirm: false }); other = await openPlayer(browser, server.url('live'), 'Other', { autoConfirm: false });
    await loadFixture(host); await waitFor(actor, () => session.loaded); await waitFor(other, () => session.loaded);
    for (const [page, ids] of [[host, [1, 3]], [actor, [2, 4]]]) for (const id of ids) {
      await claimAndSelect(page, id); await page.evaluate(async id => { const buffer = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 }); for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = .09 * Math.sin(i * .083) + .015 * Math.sin(i * .16);
        await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: id, nick: myName, audioStart: 0, trimStart: .1, trimEnd: .8, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() }); }, id);
      await waitFor(page, id => !!session.lines.find(line => line.id === id).audioUrl, 15000, id);
    }
    originalHash = await host.evaluate(async () => Array.from(new Uint8Array(await (await fetch(session.lines.find(line => line.id === 1).audioUrl)).arrayBuffer())));
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('create, explicit private assignment, atomic host bulk and refusal of foreign take assignment', async () => {
    assert.equal((await call(actor, 'voice_preset_update', { action: 'create', id: 'phone', revision: 0, name: 'Shared Phone', settings: { effects: [effect('phone-stage')], pitch: -2 } })).ok, true);
    await waitFor(host, () => !!session.voicePresets.phone);
    await actor.evaluate(() => DublineVoiceEditor.open(2, 'takes')); await actor.$eval('#fxPresets', node => { node.open = true; }); await actor.select('#fxPresetSelect', 'phone'); await actor.click('#fxPresetApply');
    assert.equal(await actor.evaluate(() => DublineVoiceEditor.draft().effects.length), 1); assert.equal(await host.evaluate(() => session.lines.find(line => line.id === 2).voicePresetId || null), null);
    await actor.click('#fxApply'); await waitFor(host, () => session.lines.find(line => line.id === 2).voicePresetId === 'phone');
    const request = await host.evaluate(() => ({ scope: 'takes', action: 'replace', editPreset: true, presetRevision: 1, settings: DublineVoiceChain.take(DublineVoicePresets.link(session.lines.find(line => line.id === 1), session, 'phone', true)), takes: session.lines.filter(line => [1, 3].includes(line.id)).map(line => ({ lineId: line.id, character: line.character, audioUrl: line.audioUrl, takeId: line.takeId, takeMixRevision: line.takeMixRevision || 0 })) }));
    assert.equal((await call(other, 'voice_update', request)).reason, 'fx.owner'); assert.equal((await call(host, 'voice_update', request)).ok, true);
    await waitFor(actor, () => session.lines.filter(line => line.voicePresetId === 'phone').length === 3);
  });
  test('linked take offers explicit shared editing/detach; draft audition does not alter others or export snapshot', async () => {
    await host.evaluate(async () => { const linked = session.lines.find(line => line.id === 1), untouched = session.lines.find(line => line.id === 4); window.priorSound = await audio.getProcessedTake(linked, { strict: true }); window.unrelatedSound = await audio.getProcessedTake(untouched, { strict: true }); window.originalRaw = await audio.getRawTake(linked.audioUrl); window.sameSourceCopy = DublineVoicePresets.detach(linked, session, newUploadId); window.copiedSound = await audio.getProcessedTake(sameSourceCopy, { strict: true }); if (copiedSound !== priorSound) throw Error('Equivalent independent copy must share the resolved buffer'); window.exportFrozen = createExportSnapshot(); });
    frozenKey = await host.evaluate(() => DublineVoiceChain.key(DublineVoiceChain.resolve(exportFrozen.scene.lines.find(line => line.id === 1), exportFrozen.scene))); wetCount = await host.evaluate(() => audio.cacheStats().noise.wetEntries);
    await actor.evaluate(() => DublineVoiceEditor.open(2, 'takes')); assert.equal(await actor.$eval('#fxLinked', node => node.hidden), false); assert.equal(await actor.$eval('#fxAdd', node => node.disabled), false);
    await actor.$eval('#fxRows [data-action=amount]', node => { node.value = 30; node.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await actor.$eval('#fxDirty', node => node.hidden), false); assert.equal(await host.evaluate(() => session.voicePresets.phone.effects[0].amount), .8);
    await waitFor(actor, () => !document.getElementById('fxPlay').disabled); await actor.click('#fxPlay'); await waitFor(actor, () => document.getElementById('fxPlay').textContent === t('fx.play'));
    assert.equal(await host.evaluate(() => session.voicePresets.phone.revision), 1);
  });
  test('confirmed preset edit changes actual PCM for every linked line and preserves raw/Wet/unrelated caches and frozen export', async () => {
    await actor.click('#fxLinkedEdit'); await waitFor(actor, () => !!document.querySelector('dialog.text-prompt[open]')); assert.ok(await actor.$eval('#textPromptTitle', node => node.textContent.includes('3'))); await actor.click('#textPromptSave');
    await waitFor(host, () => session.voicePresets.phone.revision === 2); await waitFor(actor, () => DublineVoiceEditor.draft()?.modified === false); await actor.click('#fxApply'); await waitFor(actor, () => !fxDialog.open);
    const measured = await host.evaluate(async () => { const linked = session.lines.find(line => line.id === 1), next = await audio.getProcessedTake(linked, { strict: true }), unaffected = await audio.getProcessedTake(session.lines.find(line => line.id === 4), { strict: true }); let difference = 0; const a = priorSound.getChannelData(0), b = next.getChannelData(0); for (let i = 0; i < Math.min(a.length, b.length); i++) difference += Math.abs(a[i] - b[i]); return { sameSourceCopy: copiedSound === await audio.getProcessedTake(sameSourceCopy, { strict: true }), frozenBuffer: priorSound === await audio.getProcessedTake(exportFrozen.scene.lines.find(line => line.id === 1), { strict: true }), difference, rawSame: originalRaw === await audio.getRawTake(linked.audioUrl), unrelatedSame: unrelatedSound === unaffected, wet: audio.cacheStats().noise.wetEntries, frozen: DublineVoiceChain.key(DublineVoiceChain.resolve(exportFrozen.scene.lines.find(line => line.id === 1), exportFrozen.scene)), live: DublineVoiceChain.key(DublineVoiceChain.resolve(linked, session)) }; });
    assert.ok(measured.sameSourceCopy); assert.ok(measured.frozenBuffer); assert.ok(measured.difference > .1); assert.ok(measured.rawSame && measured.unrelatedSame); assert.equal(measured.wet, wetCount); assert.equal(measured.frozen, frozenKey); assert.notEqual(measured.live, frozenKey);
    assert.equal((await call(other, 'voice_preset_update', { action: 'update', id: 'phone', revision: 2, settings: { effects: [] } })).reason, 'preset.owner');
    assert.equal((await call(actor, 'voice_preset_update', { action: 'rename', id: 'phone', revision: 1, name: 'Stale' })).reason, 'preset.conflict');
  });
  test('Save as new captures a shared draft without changing original references, then Cancel protects dirty work', async () => {
    await actor.evaluate(() => DublineVoiceEditor.open('phone', 'preset')); await actor.$eval('#fxRows [data-action=amount]', node => { node.value = 60; node.dispatchEvent(new Event('input', { bubbles: true })); }); await actor.$eval('#fxPresets', node => { node.open = true; }); await actor.click('#fxPresetSave'); await answerTextPrompt(actor, 'Variant');
    await waitFor(host, () => Object.values(session.voicePresets).some(preset => preset.name === 'Variant'));
    assert.equal(await host.evaluate(() => session.voicePresets.phone.effects[0].amount), .3); assert.equal(await host.evaluate(() => session.lines.filter(line => line.voicePresetId === 'phone').length), 3);
    await actor.click('#fxCancel'); await waitFor(actor, () => !!document.querySelector('dialog.text-prompt[open]')); await actor.click('#textPromptContinue'); assert.equal(await actor.$eval('#fxDialog', node => node.open), true);
    await actor.click('#fxCancel'); await waitFor(actor, () => !!document.querySelector('dialog.text-prompt[open]')); await actor.click('#textPromptCancel'); assert.equal(await actor.$eval('#fxDialog', node => node.open), false);
  });
  test('lost acknowledgements recover one shared revision and keep the edited draft protected', async () => {
    await actor.evaluate(() => { DublineVoiceEditor.open('phone', 'preset'); const emit = socket.emit, onack = socket.onack, dropped = new Set(); window.liveRequests = []; window.restoreLiveAck = () => { socket.emit = emit; socket.onack = onack; };
      socket.emit = function(event, ...args) { if (event === 'voice_preset_update' && liveRequests.length < 2) { dropped.add(this.ids); liveRequests.push(args[0].operationId); } return emit.call(this, event, ...args); };
      socket.onack = function(packet) { if (dropped.delete(packet.id)) return; return onack.call(this, packet); };
    });
    try { await actor.$eval('#fxPitch', node => { node.value = '-3'; node.dispatchEvent(new Event('input', { bubbles: true })); }); await actor.click('#fxApply'); await waitFor(actor, () => !!document.querySelector('dialog.text-prompt[open]')); await actor.click('#textPromptSave'); await actor.click('#fxClose'); assert.equal(await actor.$eval('#fxDialog', node => node.open && node.querySelector('.fx-body').inert), true);
      await waitFor(actor, () => !document.getElementById('fxDialog').open, 18000); assert.equal(await actor.evaluate(() => new Set(liveRequests).size), 1); assert.equal(await host.evaluate(() => session.voicePresets.phone.revision), 3);
    } finally { await actor.evaluate(() => restoreLiveAck()); }
  });
  test('recording replacement, pinning and restoration retain the shared link in real history', async () => {
    await claimAndSelect(actor, 2); await actor.evaluate(async () => { const buffer = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 }); for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = .07 * Math.sin(i * .09); await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: 2, nick: myName, audioStart: 0, trimStart: .1, trimEnd: .8, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() }); });
    await waitFor(actor, () => session.lines.find(line => line.id === 2).takeHistory.length === 1); assert.equal(await actor.evaluate(() => session.lines.find(line => line.id === 2).takeHistory[0].voicePresetId), 'phone');
    for (const action of ['pin', 'restore']) { const request = await actor.evaluate(action => { const line = session.lines.find(line => line.id === 2), take = line.takeHistory[0]; return { room: currentRoom, lineId: 2, takeId: take.id, historyRevision: line.takeHistoryRevision, expectedOwner: getLineOwner(line), action, value: true }; }, action); assert.equal((await call(actor, 'take_history_update', request)).ok, true); }
    await waitFor(host, () => session.lines.find(line => line.id === 2).takePinned); assert.equal(await host.evaluate(() => DublineVoiceChain.resolve(session.lines.find(line => line.id === 2).takeHistory[0], session).effects[0].amount), .3);
  });
  test('history captures and restores the live link; one-take detach changes only its own settings', async () => {
    const saved = await actor.evaluate(() => { const line = session.lines.find(line => line.id === 2); return DublineTakeHistoryModel.extract(line); }); assert.equal(saved.voicePresetId, 'phone');
    await actor.evaluate(() => DublineVoiceEditor.open(2, 'takes')); const sound = await actor.evaluate(() => DublineVoiceChain.key(DublineVoiceChain.resolve(session.lines.find(line => line.id === 2), session)));
    await actor.click('#fxDetach'); assert.equal(await actor.$eval('#fxAdd', node => node.disabled), false); assert.equal(await host.evaluate(() => session.lines.find(line => line.id === 2).voicePresetId), 'phone');
    await actor.click('#fxApply'); await waitFor(host, () => session.lines.find(line => line.id === 2).voicePresetId === null);
    assert.equal(await actor.evaluate(() => DublineVoiceChain.key(DublineVoiceChain.resolve(session.lines.find(line => line.id === 2), session))), sound);
    assert.equal(await host.evaluate(() => session.lines.find(line => line.id === 1).voicePresetId), 'phone');
  });
  test('used deletion rejects omission of detach, rolls back disk failure and then preserves others sound', async () => {
    const sound = await host.evaluate(() => DublineVoiceChain.key(DublineVoiceChain.resolve(session.lines.find(line => line.id === 1), session)));
    assert.equal((await call(actor, 'voice_preset_update', { action: 'delete', id: 'phone', revision: 3 })).reason, 'preset.inUse');
    const blocker = path.join(server.dirs.data, 'rooms.json.tmp'); assert.ok(blocker.startsWith(server.dirs.data + path.sep)); fs.mkdirSync(blocker);
    try { assert.equal((await call(actor, 'voice_preset_update', { action: 'delete', id: 'phone', revision: 3, detach: true })).reason, 'preset.storage'); } finally { fs.rmdirSync(blocker); }
    assert.equal(await host.evaluate(() => session.lines.find(line => line.id === 1).voicePresetId), 'phone');
    assert.equal((await call(actor, 'voice_preset_update', { action: 'delete', id: 'phone', revision: 3, detach: true })).ok, true); await waitFor(host, () => !session.voicePresets.phone && session.lines.find(line => line.id === 1).voicePresetId === null);
    assert.equal(await host.evaluate(() => DublineVoiceChain.key(DublineVoiceChain.resolve(session.lines.find(line => line.id === 1), session))), sound);
  });
  test('format 13 and host restart retain explicit live links, metadata and exact recording bytes', async () => {
    const id = await actor.evaluate(() => Object.values(session.voicePresets).find(preset => preset.name === 'Variant').id);
    const request = await actor.evaluate(id => { const line = session.lines.find(line => line.id === 2); return { scope: 'takes', action: 'replace', editPreset: true, presetRevision: 1, settings: DublineVoiceChain.take(DublineVoicePresets.link(line, session, id, true)), takes: [{ lineId: line.id, character: line.character, audioUrl: line.audioUrl, takeId: line.takeId, takeMixRevision: line.takeMixRevision || 0 }] }; }, id);
    assert.equal((await call(actor, 'voice_update', request)).ok, true); await waitFor(host, id => session.lines.find(line => line.id === 2).voicePresetId === id, 10000, id);
    const bytes = await host.evaluate(async () => { const barrier = await prepareSafeSnapshot('project'); const response = await fetch('/api/export-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, ...barrier }) }); if (!response.ok) throw Error(await response.text()); return Array.from(new Uint8Array(await response.arrayBuffer())); });
    const read = require('../server/projects').readProject(Buffer.from(bytes)); assert.equal(read.manifest.formatVersion, 13); assert.equal(read.manifest.project.lines.find(line => line.id === 2).take.voicePresetId, id);
    await server.restart(); await waitFor(host, id => socket.connected && hasSceneMediaAccess() && session.lines.find(line => line.id === 2)?.voicePresetId === id, 20000, id);
    const current = await host.evaluate(async () => Array.from(new Uint8Array(await (await fetch(session.lines.find(line => line.id === 1).audioUrl)).arrayBuffer()))); assert.deepEqual(current, originalHash);
  });
  test('shared impact, dirty labels and editable linked controls remain usable across themes, languages and scales', async () => {
    const id = await actor.evaluate(() => Object.values(session.voicePresets).find(preset => preset.name === 'Variant').id); await actor.setViewport({ width: 820, height: 900 }); await actor.evaluate(id => DublineVoiceEditor.open(id, 'preset'), id);
    for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) for (const zoom of [1, 1.25, 1.5]) {
      await actor.evaluate(async (theme, language, zoom) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); document.body.style.zoom = String(zoom); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, theme, language, zoom);
      await waitFor(actor, () => getComputedStyle(DublineDropdown.button(document.getElementById('fxSample'))).backgroundColor === getComputedStyle(document.getElementById('fxDialog')).backgroundColor);
      assert.equal(await actor.$eval('#fxApply', node => node.textContent), await actor.evaluate(() => t('live.save')));
      const geometry = await actor.evaluate(() => { const dialog = document.getElementById('fxDialog'), box = dialog.getBoundingClientRect(), button = document.getElementById('fxApply').getBoundingClientRect(); return { fits: box.left >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1, footer: button.height > 0 && button.top >= box.top && button.bottom <= box.bottom, overflow: dialog.scrollWidth > dialog.clientWidth + 1 }; }); assert.ok(geometry.fits && geometry.footer && !geometry.overflow, JSON.stringify({ theme, language, zoom, geometry }));
    }
    await actor.evaluate(async () => { document.documentElement.dataset.theme = 'light'; await DublineI18n.setLanguage('ru'); }); await waitFor(actor, () => getComputedStyle(DublineDropdown.button(document.getElementById('fxSample'))).backgroundColor === 'rgb(255, 255, 255)'); await actor.screenshot({ path: path.join(__dirname, '../audit/live-presets/shared-light-ru-150.png') }); await close(actor); await actor.evaluate(() => { document.body.style.zoom = ''; }); await actor.setViewport({ width: 1600, height: 900 });
  });
  test('role preset pitch updates an audition even with role effects bypassed', async () => {
    assert.ok((await call(host, 'voice_preset_update', { action: 'create', id: 'pitch-only', name: 'Role pitch', revision: 0, settings: { effects: [], pitch: 1 } })).ok);
    const role = await host.evaluate(() => ({ scope: 'role', character: 'Hero', revision: session.roleEffects.Hero?.revision || 0, presetRevision: 1, settings: { effects: [], pitch: 0, voicePresetId: 'pitch-only', usePresetPitch: true } })); assert.ok((await call(host, 'voice_update', role)).ok);
    const take = await host.evaluate(() => { const line = session.lines.find(line => line.id === 1); return { scope: 'takes', action: 'replace', editPitch: true, editInheritance: true, settings: { ...DublineVoiceChain.take(line), pitchMode: 'inherit', inheritRoleEffects: false }, takes: [{ lineId: 1, character: line.character, takeId: line.takeId, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision || 0 }] }; }); assert.ok((await call(host, 'voice_update', take)).ok);
    await host.evaluate(async () => { const line = session.lines.find(line => line.id === 1); window.pitchBeforeBuffer = await audio.getProcessedTake(line, { strict: true }); window.pitchRaw = await audio.getRawTake(line.audioUrl); await audio.previewTake(line); }); assert.ok(await host.evaluate(() => DublineVoicePresets.usage(session, 'pitch-only').lines.includes(1))); await host.evaluate(() => new Promise(resolve => setTimeout(resolve, 100))); assert.ok(await host.evaluate(() => audio.previewPosition() > 0));
    assert.ok((await call(host, 'voice_preset_update', { action: 'update', id: 'pitch-only', revision: 1, settings: { effects: [], pitch: 4 } })).ok); await waitFor(host, () => session.voicePresets['pitch-only'].revision === 2); assert.equal(await host.evaluate(() => audio.previewPosition()), 0);
    const result = await host.evaluate(async () => { const line = session.lines.find(line => line.id === 1); return { pitch: DublineVoiceChain.resolve(line, session).pitch, fresh: pitchBeforeBuffer !== await audio.getProcessedTake(line, { strict: true }), raw: pitchRaw === await audio.getRawTake(line.audioUrl) }; }); assert.equal(result.pitch, 4); assert.ok(result.fresh && result.raw);
  });
  test('no unhandled renderer errors', () => { assert.deepEqual(host.errors, []); assert.deepEqual(actor.errors, []); assert.deepEqual(other.errors, []); });
});
