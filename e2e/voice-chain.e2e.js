const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor } = require('./helpers');
const effect = (type, amount = 1, id = type) => ({ id, type, enabled: true, amount, parameters: {} });
describe('voice chains: real DSP, inspector, author rights and scoped collaboration', { skip: skipReason, timeout: 120000 }, () => {
  let server, browser, host, guest, projectBytes;
  const update = (page, data) => page.evaluate(data => new Promise(resolve => {
    socket.emit('voice_update', { sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now(), ...data }, resolve);
  }), data);
  const takeRequest = (page, ids, settings, action = 'replace') => page.evaluate((ids, settings, action) => ({ scope: 'takes', action, settings, takes: ids.map(id => { const line = session.lines.find(item => item.id === id); return { lineId: id, character: line.character, takeId: line.takeId, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision || 0 }; }) }), ids, settings, action);
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port); host = await openPlayer(browser, server.url('voice-chains'), 'Host', { autoConfirm: false }); guest = await openPlayer(browser, server.url('voice-chains'), 'Actor');
    await loadFixture(host); await waitFor(guest, () => session?.loaded);
    for (const [page, id] of [[host, 1], [guest, 2]]) {
      await claimAndSelect(page, id);
      await page.evaluate(async id => {
        const buffer = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 }), pcm = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) pcm[i] = i < 32000 ? .08 * Math.sin(2 * Math.PI * (180 * i / 48000 + 900 * (i / 48000) ** 2)) : 0;
        await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: id, nick: myName, audioStart: 1, trimStart: 0, trimEnd: .67, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() });
      }, id);
      await waitFor(page, id => !!session.lines.find(line => line.id === id).audioUrl, 15000, id);
    }
    await waitFor(host, () => session.lines.filter(line => line.audioUrl).length === 2);
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('sequential DSP changes with order, amounts, disabled/duplicate stages; legacy Monster stays identical', async () => {
    assert.equal(await host.$eval('#fxDialog', node => node.getClientRects().length), 0, 'closed editor must not cover studio controls');
    const result = await host.evaluate(async () => {
      const fx = DublineAudioFx, model = DublineVoiceChain, input = new AudioBuffer({ length: 12000, sampleRate: 48000, numberOfChannels: 1 });
      for (let i = 0; i < input.length; i++) input.getChannelData(0)[i] = .06 * Math.sin(2 * Math.PI * 270 * i / 48000) + .025 * Math.sin(2 * Math.PI * 1800 * i / 48000);
      const item = (type, amount = 1) => ({ id: type, type, amount, enabled: true, parameters: {} });
      const config = effects => ({ pitch: 0, effects, tail: effects.reduce((sum, effect) => sum + model.tail(effect), 0) });
      const difference = (a, b) => { let sum = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) sum += Math.abs(a.getChannelData(0)[i] - b.getChannelData(0)[i]); return sum; };
      const a = await fx.renderChain(input, config([item('robot', .7), item('telephone', .8)])), b = await fx.renderChain(input, config([item('telephone', .8), item('robot', .7)]));
      const legacy = await fx.renderVoice(input, 'monster', -2, null, .5), chain = await fx.renderChain(input, { ...config([item('monster', .5)]), pitch: -2 });
      const bypass = await fx.renderChain(input, config([{ ...item('robot'), enabled: false }, item('echo', 0)]));
      const duplicate = await fx.renderChain(input, config([item('radio', .3), { ...item('radio', .6), id: 'second' }]));
      return { orderDifference: difference(a, b), legacyDifference: difference(legacy, chain), bypassDifference: difference(input, bypass), peak: Math.max(...duplicate.getChannelData(0)), finite: [...duplicate.getChannelData(0)].every(Number.isFinite), unchanged: input.length === 12000 };
    });
    assert.ok(result.orderDifference > .1); assert.equal(result.legacyDifference, 0); assert.equal(result.bypassDifference, 0); assert.ok(result.peak <= .951); assert.ok(result.finite && result.unchanged);
  });
  test('Echo has decaying repeats, trimmed speech does not return, and tails accumulate', async () => {
    const result = await host.evaluate(async () => {
      const input = new AudioBuffer({ length: 24000, sampleRate: 48000, numberOfChannels: 1 }); input.getChannelData(0)[2000] = .1; input.getChannelData(0)[17000] = .3;
      const item = { id: 'echo', type: 'echo', enabled: true, amount: 1, parameters: { delay: .1, feedback: .5 } };
      const rendered = await DublineAudioFx.renderChain(input, { pitch: 0, effects: [item], tail: DublineVoiceChain.tail(item) }, { from: 0, to: .1 });
      const data = rendered.getChannelData(0), peak = at => Math.max(...data.slice(at - 16, at + 16).map(Math.abs)); return { duration: rendered.duration, first: peak(6800), second: peak(11600), impulses: [...data.keys()].filter(i => Math.abs(data[i]) > .01).slice(0, 18), discarded: Math.abs(data[17000]), source: input.getChannelData(0)[17000] };
    });
    assert.ok(result.duration > 1); assert.ok(result.first > result.second && result.second > 0, JSON.stringify(result)); assert.equal(result.discarded, 0); assert.ok(result.source > .29);
  });
  test('role effects affect existing/future lines, preserve individual pitch, enforce rights and revision conflicts', async () => {
    const request = { scope: 'role', character: 'Friend', revision: 0, settings: { pitch: -3, effects: [effect('robot', .6), effect('echo', .3)] } };
    assert.equal((await update(guest, request)).reason, 'fx.owner'); assert.equal((await update(host, request)).ok, true);
    await waitFor(guest, () => session.roleEffects?.Friend?.revision === 1);
    assert.equal((await update(host, request)).reason, 'fx.conflict');
    assert.deepEqual(await guest.evaluate(() => DublineVoiceChain.resolve(session.lines.find(line => line.id === 2), session).effects.map(item => item.type)), ['robot', 'echo']);
    assert.equal(await guest.evaluate(() => DublineVoiceChain.resolve(session.lines.find(line => line.id === 4), session).pitch), -3);
    const settings = { effects: [effect('telephone', .4)], pitchMode: 'override', inheritRoleEffects: true, excludedRoleEffectIds: ['echo'] };
    const data = await takeRequest(guest, [2], settings); assert.equal((await update(guest, { ...data, pitch: 2 })).ok, true);
    await waitFor(host, () => session.lines.find(line => line.id === 2).effects?.[0]?.type === 'telephone');
    assert.deepEqual(await host.evaluate(() => { const config = DublineVoiceChain.resolve(session.lines.find(line => line.id === 2), session); return { pitch: config.pitch, types: config.effects.map(item => item.type) }; }), { pitch: 2, types: ['robot', 'telephone'] });
    assert.equal((await update(host, data)).reason, 'fx.conflict');
    const foreign = await takeRequest(guest, [1], settings); assert.equal((await update(guest, foreign)).reason, 'fx.owner');
  });
  test('draft preview, A/B, independent slider changes, reorder and Cancel leave shared take unchanged', async () => {
    const before = await host.evaluate(() => JSON.stringify(session));
    await guest.evaluate(() => DublineVoiceEditor.open(2, 'takes')); await waitFor(guest, () => document.getElementById('fxDialog').open);
    await guest.click('[data-fx-type="' + 'echo' + '"]');
    await guest.$eval('#fxRows [data-action="amount"]', input => { input.value = '23'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await guest.click('#fxRows [data-action="down"]'); await waitFor(guest, () => document.getElementById('fxStatus').textContent === t('fx.ready'));
    await guest.click('#fxPlay'); await guest.select('#fxAB', 'dry'); await guest.click('#fxCancel');
    await waitFor(guest, () => document.querySelector('dialog.text-prompt[open]')); await guest.click('#textPromptCancel'); await waitFor(guest, () => !document.getElementById('fxDialog').open);
    assert.equal(await host.evaluate(() => JSON.stringify(session)), before);
    assert.equal(await guest.evaluate(() => session.lines.find(line => line.id === 2).effects[0].amount), .4);
  });
  test('combined limits reject unsafe role updates without changing state', async () => {
    const before = await host.evaluate(() => JSON.stringify(session.roleEffects));
    const result = await update(host, { scope: 'role', character: 'Friend', revision: 1, settings: { pitch: 0, effects: Array.from({ length: 8 }, (_, i) => effect('robot', 1, 'r' + i)) } });
    assert.equal(result.reason, 'fx.limit'); assert.equal(await host.evaluate(() => JSON.stringify(session.roleEffects)), before);
  });
  test('pointer drag commits one final local order, preserves per-instance strength and never broadcasts a draft', async () => {
    const before = await host.evaluate(() => JSON.stringify(session.lines));
    await guest.evaluate(() => DublineVoiceEditor.open(2, 'takes')); await guest.click('[data-fx-type="' + 'radio' + '"]');
    const a = await guest.$eval('#fxRows .fx-grip', node => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const b = await guest.$eval('#fxRows .fx-item:last-child', node => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await guest.mouse.move(a.x, a.y); await guest.mouse.down(); await guest.mouse.move(b.x, b.y, { steps: 8 }); await guest.mouse.up();
    assert.deepEqual(await guest.$$eval('#fxRows .fx-item b', nodes => nodes.map(node => node.textContent)), await guest.evaluate(() => [t('fx.name.telephone'), t('fx.name.radio'), t('fx.name.pitch')]));
    assert.equal(await guest.$eval('#fxRows [data-action=amount]', node => node.value), '40');
    await guest.click('#fxCancel'); await waitFor(guest, () => document.querySelector('dialog.text-prompt[open]')); await guest.click('#textPromptCancel'); await waitFor(guest, () => !document.getElementById('fxDialog').open); assert.equal(await host.evaluate(() => JSON.stringify(session.lines)), before);
  });
  test('replacement and history restore retain individual chain, inheritance, pitch and pin without duplicate stages', async () => {
    const old = await guest.evaluate(() => structuredClone(session.lines.find(line => line.id === 2)));
    await guest.evaluate(async () => {
      const line = session.lines.find(item => item.id === 2), buffer = new AudioBuffer({ length: 24000, sampleRate: 48000, numberOfChannels: 1 }); buffer.getChannelData(0).fill(.015);
      await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: 2, nick: myName, audioStart: 1, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() });
    });
    await waitFor(guest, old => session.lines.find(line => line.id === 2).takeId !== old, 15000, old.takeId);
    assert.deepEqual(await guest.evaluate(() => session.lines.find(line => line.id === 2).takeHistory[0].effects), old.effects);
    const settings = { effects: [effect('echo', .2, 'individual-echo')], pitchMode: 'inherit', inheritRoleEffects: false, excludedRoleEffectIds: [] };
    assert.equal((await update(guest, await takeRequest(guest, [2], settings))).ok, true);
    const restored = await guest.evaluate(id => new Promise(resolve => { const line = session.lines.find(item => item.id === 2); socket.emit('take_history_update', { room: currentRoom, sessionId: session.activeSessionId, lineId: 2, takeId: id, action: 'restore', historyRevision: line.takeHistoryRevision, expectedOwner: getLineOwner(line) }, resolve); }), old.takeId);
    assert.equal(restored.ok, true); await waitFor(host, id => session.lines.find(line => line.id === 2).takeId === id, 5000, old.takeId);
    const result = await host.evaluate(() => structuredClone(session.lines.find(line => line.id === 2)));
    assert.deepEqual(result.effects, old.effects); assert.deepEqual(result.excludedRoleEffectIds, ['echo']); assert.equal(result.pitch, 2); assert.equal(result.pitchMode, 'override');
    assert.deepEqual(result.takeHistory[0].effects, settings.effects); assert.equal(result.takeHistory[0].inheritRoleEffects, false);
  });
  test('atomic bulk append, clear and inheritance preserve distinct settings and reject foreign members', async () => {
    const settings = { effects: [effect('echo', .2, 'bulk-echo')], pitchMode: 'inherit', inheritRoleEffects: true, excludedRoleEffectIds: [] };
    assert.equal((await update(host, await takeRequest(host, [1, 2], settings, 'append'))).ok, true);
    await waitFor(guest, () => session.lines.find(line => line.id === 2).effects?.at(-1)?.type === 'echo' && session.lines.find(line => line.id === 2).effects.at(-1).amount === .2);
    assert.equal(await guest.evaluate(() => session.lines.find(line => line.id === 1).effects.at(-1).id === session.lines.find(line => line.id === 2).effects.at(-1).id), false);
    const before = await host.evaluate(() => JSON.stringify(session.lines));
    assert.equal((await update(guest, await takeRequest(guest, [1, 2], settings, 'clear'))).reason, 'fx.owner');
    assert.equal(await host.evaluate(() => JSON.stringify(session.lines)), before);
    assert.equal((await update(host, await takeRequest(host, [1, 2], settings, 'clear'))).ok, true);
    assert.equal((await update(host, { ...await takeRequest(host, [1, 2], settings, 'inherit'), value: false })).ok, true);
    await waitFor(guest, () => session.lines.filter(line => line.audioUrl).every(line => line.effects.length === 0 && !line.inheritRoleEffects));
  });
  test('export snapshot freezes role chains, rendered stems retain tails and bypassed roles reuse the same buffer', async () => {
    const settings = { effects: [], pitchMode: 'inherit', inheritRoleEffects: true, excludedRoleEffectIds: [] };
    assert.equal((await update(guest, await takeRequest(guest, [2], settings))).ok, true);
    const result = await guest.evaluate(async () => {
      const snapshot = createExportSnapshot(), line = snapshot.takes.find(item => item.id === 2), before = await getProcessedTake(line);
      const saved = session.roleEffects; session.roleEffects = {}; const same = await getProcessedTake(line); session.roleEffects = saved;
      const stem = await renderCharacterStem([line], 12, 48000, snapshot);
      return { same: before === same, duration: before.duration, tail: line._exportVoice.tail, stereo: stem.numberOfChannels, finite: [...stem.getChannelData(0)].every(Number.isFinite) };
    });
    assert.ok(result.same && result.finite); assert.ok(result.duration > 1 && result.tail > .5); assert.equal(result.stereo, 2);
  });
  test('role rename and editor Undo preserve one shared definition', async () => {
    await host.evaluate(() => socket.emit('set_session_mode', { sessionId: session.activeSessionId, mode: 'edit' })); await waitFor(host, () => session.mode === 'edit');
    const rename = await host.evaluate(() => new Promise(resolve => socket.emit('rename_character', { sessionId: session.activeSessionId, from: 'Friend', to: 'Renamed', lines: session.lines.filter(line => line.character === 'Friend').map(line => ({ lineId: line.id, revision: line.revision || 0 })), trackOrder: session.trackOrder }, resolve)));
    assert.equal(rename.ok, true); await waitFor(guest, () => session.trackOrder.includes('Renamed'));
    assert.equal(await host.evaluate(() => session.roleEffects.Renamed.effects.length), 2); assert.equal(await host.evaluate(() => Object.hasOwn(session.roleEffects, 'Friend')), false);
    const undo = await host.evaluate(() => new Promise(resolve => socket.emit('editor_undo', { sessionId: session.activeSessionId }, resolve)));
    assert.ok(undo.undone > 0); await waitFor(guest, () => session.trackOrder.includes('Friend')); assert.equal(await host.evaluate(() => session.roleEffects.Friend.effects.length), 2);
    await host.evaluate(() => socket.emit('set_session_mode', { sessionId: session.activeSessionId, mode: 'dub' })); await waitFor(host, () => session.mode === 'dub');
  });
  test('portable project archive contains role and historical chains; original recordings remain unchanged', async () => {
    const bytes = await host.evaluate(async () => {
      const barrier = await prepareSafeSnapshot('project'), response = await fetch('/api/export-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, ...barrier }) });
      if (!response.ok) throw Error(await response.text()); return Array.from(new Uint8Array(await response.arrayBuffer()));
    });
    projectBytes = bytes;
    const project = require('../server/projects').readProject(Buffer.from(bytes)); assert.equal(project.manifest.formatVersion, 8);
    assert.equal(project.manifest.project.roleEffects.Friend.effects.length, 2);
    assert.equal(project.manifest.project.lines.find(line => line.id === 2).takeHistory[0].effects[0].type, 'echo');
  });
  test('actual project reopening gives a fresh scene and retains shared/individual/historical settings', async () => {
    const oldId = await host.evaluate(() => session.activeSessionId);
    await host.evaluate(async bytes => {
      const form = new FormData(); form.append('clientId', clientId); form.append('sessionId', session.activeSessionId); form.append('project', new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), 'effects.dubline');
      const response = await fetch('/api/import-project?room=' + encodeURIComponent(currentRoom), { method: 'POST', body: form }); if (!response.ok) throw Error(await response.text());
    }, projectBytes);
    await waitFor(guest, old => session.activeSessionId !== old && session.roleEffects?.Friend?.effects?.length === 2, 20000, oldId);
    assert.equal(await guest.evaluate(() => session.roleEffects.Friend.revision), 0);
    assert.equal(await guest.evaluate(() => session.lines.find(line => line.id === 2).takeHistory[0].effects[0].type), 'echo');
    assert.ok(await guest.evaluate(async () => (await getProcessedTake(session.lines.find(line => line.id === 2))).duration > 1));
  });
  test('empty roles can be configured from their track label before recording any take', async () => {
    const added = await host.evaluate(() => new Promise(resolve => socket.emit('editor_add_track', { sessionId: session.activeSessionId, character: 'Empty role' }, resolve))); assert.equal(added.ok, true);
    await waitFor(host, () => document.querySelector('[data-character="Empty role"] .track-fx'));
    await host.locator('[data-character="Empty role"] .track-fx').click(); assert.equal(await host.$eval('#fxRows', node => node.children.length), 0);
    await host.click('[data-fx-type="' + 'echo' + '"]'); await host.click('#fxPresetSave'); await waitFor(host,()=>textPrompt.open); await host.$eval('#textPromptInput',n=>{n.value='Empty echo';}); await host.click('#textPromptSave'); await waitFor(host,()=>!DublinePresetUI.pending()&&DublineVoiceEditor.draft()?.presetId); await host.click('#fxApply');
    await waitFor(host, () => document.querySelector('dialog.text-prompt[open]')); await host.click('#textPromptSave');
    await waitFor(guest, () => DublineVoiceChain.roleVoice(session, 'Empty role').effects?.[0]?.type === 'echo'); assert.equal(await guest.evaluate(() => session.lines.filter(line => line.character === 'Empty role').length), 0);
  });
  test('host/moderator concurrent role edits reject the stale revision instead of losing a change', async () => {
    assert.equal((await host.evaluate(() => new Promise(resolve => socket.emit('host_grant_moderator', { nick: 'Actor' }, resolve)))).ok, true); await waitFor(guest, () => canModerate());
    const revision = await host.evaluate(() => session.roleEffects.Friend.revision);
    const requests = [-1, 1].map(pitch => ({ scope: 'role', character: 'Friend', revision, settings: { pitch, effects: [effect('echo', .3)] } }));
    const results = await Promise.all([update(host, requests[0]), update(guest, requests[1])]); assert.equal(results.filter(result => result.ok).length, 1); assert.equal(results.find(result => !result.ok).reason, 'fx.conflict');
  });
  test('themes, locales and narrow zoomed editor preserve drafts and fit without horizontal overflow', async () => {
    await guest.setViewport({ width: 640, height: 850 });
    await guest.evaluate(() => DublineVoiceEditor.open(2, 'takes'));
    for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
      await guest.evaluate(async (theme, language) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); document.body.style.zoom = '150%'; }, theme, language);
      assert.equal(await guest.$eval('#fxDialog', node => node.scrollWidth <= node.clientWidth + 1), true);
      assert.equal(await guest.$eval('#fxDialog', node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1; }), true);
      assert.equal(await guest.$eval('#fxAdd', node => node.textContent), await guest.evaluate(() => t('fx.add')));
    }
    await guest.evaluate(() => { document.body.style.zoom = ''; DublineVoiceEditor.close(); });
    await guest.setViewport({ width: 1600, height: 900 });
  });
  test('bulk own-chain clearing removes pitch while preserving role inheritance after confirmation', async () => {
    const own = (type, amount, mode, inherit) => ({ effects: [effect(type, amount)], pitchMode: mode, inheritRoleEffects: inherit, excludedRoleEffectIds: [] });
    assert.equal((await update(host, { ...await takeRequest(host, [1], own('telephone', .3, 'override', false)), pitch: 4 })).ok, true);
    assert.equal((await update(guest, await takeRequest(guest, [2], own('radio', .4, 'inherit', true)))).ok, true);
    await waitFor(host, () => session.lines.find(line => line.id === 2).effects[0].type === 'radio');
    await host.evaluate(() => { multiSelection.clear(); multiSelection.add(1); multiSelection.add(2); DublineVoiceEditor.bulk(); });
    assert.equal(await host.$('#fxPitchMode'), null); assert.equal(await host.$eval('#fxInherit', node => node.indeterminate), true);
    await host.click('#fxClearChain'); assert.equal(await host.$eval('#fxRows', node => node.children.length), 0);
    await host.click('[data-fx-type="' + 'echo' + '"]');
    await host.$eval('#fxRows input[type="range"]', node => { node.value = '20'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await host.click('#fxApply'); await waitFor(host, () => document.querySelector('dialog.text-prompt[open]')); await host.click('#textPromptSave');
    await waitFor(guest, () => [1, 2].every(id => session.lines.find(line => line.id === id).effects.length === 1 && session.lines.find(line => line.id === id).effects[0].type === 'echo' && session.lines.find(line => line.id === id).effects[0].amount === .2));
    const values = await guest.evaluate(() => [1, 2].map(id => { const line = session.lines.find(item => item.id === id); return { types: line.effects.map(item => item.type), pitch: line.pitch, mode: line.pitchMode, inherit: line.inheritRoleEffects, echo: line.effects[0].amount }; }));
    assert.deepEqual(values[0], { types: ['echo'], pitch: 0, mode: 'override', inherit: false, echo: .2 }); assert.equal(values[1].mode, 'override'); assert.equal(values[1].inherit, true); assert.deepEqual(values[1].types, ['echo']);
    await host.evaluate(() => { multiSelection.clear(); });
  });
});
