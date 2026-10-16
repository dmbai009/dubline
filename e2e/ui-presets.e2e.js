const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor, answerTextPrompt } = require('./helpers');
const effect = (id, type = 'radio', amount = .65) => ({ id, type, amount, enabled: true, parameters: type === 'echo' ? { delay: .15, feedback: .25 } : {} });
describe('scene presets, consistent controls and one-shot previews', { skip: skipReason, timeout: 240000 }, () => {
  let server, browser, host, actor, other, savedId, projectBytes, originalHash;
  const call = (page, event, data) => page.evaluate((event, data) => new Promise(resolve => socket.emit(event, { sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now(), ...data }, resolve)), event, data);
  const preset = (page, data) => call(page, 'voice_preset_update', data);
  const closeFx = page => page.evaluate(() => DublineVoiceEditor.close(true));
  // Text and key must describe the same browser turn: preview completion can
  // change both between separate protocol round trips.
  const localizedStatus = page => page.$eval('#fxStatus', node => ({ key: node.dataset.i18n, actual: node.textContent, expected: t(node.dataset.i18n) }));
  before(async () => {
    fs.mkdirSync(path.resolve('audit/ui-presets'), { recursive: true });
    server = await startServer(); browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url('ui-presets'), 'Host', { autoConfirm: false }); actor = await openPlayer(browser, server.url('ui-presets'), 'Actor', { autoConfirm: false }); other = await openPlayer(browser, server.url('ui-presets'), 'Other', { autoConfirm: false });
    await loadFixture(host); await waitFor(actor, () => session?.loaded); await waitFor(other, () => session?.loaded);
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('RNNoise unavailable preview explains itself on keyboard focus and hover using shared help', async () => {
    await actor.evaluate(() => DublineNoise.open()); await waitFor(actor, () => !!DublineNoise.snapshot());
    assert.equal(await actor.$eval('#noisePreviewPlay', node => node.disabled), true);
    await waitFor(actor, () => document.getElementById('noisePreviewPlay').parentElement.dataset.tooltip === t('noise.noSampleHelp'));
    await actor.evaluate(() => document.getElementById('noisePreviewPlay').parentElement.focus());
    assert.equal(await actor.$eval('#dublineTooltip', node => !node.hidden), true);
    assert.equal(await actor.$eval('#dublineTooltip', node => node.textContent), await actor.evaluate(() => t('noise.noSampleHelp')));
    assert.equal(await actor.$eval('#noiseEffects', node => node.closest('.switch-ui') !== null), true);
    await actor.evaluate(() => document.getElementById('noiseEffectsHelp').focus()); assert.equal(await actor.$eval('#dublineTooltip', node => node.textContent), await actor.evaluate(() => t('noise.effectsHelp')));
    await actor.evaluate(() => closeSettingsModal());
  });
  test('first own recording automatically enables preview; original bytes stay untouched', async () => {
    for (const [page, id] of [[host, 1], [actor, 2]]) {
      await claimAndSelect(page, id); await page.evaluate(async id => {
        const buffer = new AudioBuffer({ length: 96000, sampleRate: 48000, numberOfChannels: 1 }); for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = .06 * Math.sin(i * .073);
        await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: id, nick: myName, audioStart: 0, trimStart: .15, trimEnd: 1.4, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() });
      }, id); await waitFor(page, id => !!session.lines.find(line => line.id === id).audioUrl, 15000, id);
    }
    await actor.evaluate(() => DublineNoise.open()); await waitFor(actor, () => !document.getElementById('noisePreviewPlay').disabled);
    originalHash = await actor.evaluate(async () => Array.from(new Uint8Array(await (await fetch(session.lines.find(line => line.id === 2).audioUrl)).arrayBuffer())));
  });
  test('RNNoise plays its actual take range once, restarts at the beginning and cannot restart after stop/end', async () => {
    await actor.click('#noisePreviewPlay'); await waitFor(actor, () => DublineNoise.snapshot()?.playing);
    const start = await actor.evaluate(() => DublineNoise.previewPosition()); assert.ok(start >= .14 && start < .6, String(start));
    await actor.$eval('#noiseStrength', node => { node.value = '45'; node.dispatchEvent(new Event('input')); });
    await waitFor(actor, () => !DublineNoise.snapshot().playing, 6000);
    assert.equal(await actor.$eval('#noisePreviewPlay', node => node.textContent), await actor.evaluate(() => t('noise.play')));
    await actor.$eval('#noiseEffects', node => { node.checked = false; node.dispatchEvent(new Event('change')); });
    await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(await actor.evaluate(() => DublineNoise.snapshot().playing), false);
    await actor.click('#noisePreviewPlay'); await waitFor(actor, () => DublineNoise.snapshot().playing); assert.ok(await actor.evaluate(() => DublineNoise.previewPosition() < .6));
    await actor.click('#noisePreviewPlay'); await actor.$eval('#noiseEffects', node => { node.checked = true; node.dispatchEvent(new Event('change')); });
    await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(await actor.evaluate(() => DublineNoise.snapshot().playing), false);
    await actor.evaluate(() => closeSettingsModal());
  });
  test('authors and role owners cannot request retakes through UI or direct Socket.IO; host and moderator can', async () => {
    await actor.evaluate(() => selectLine(session.lines.find(line => line.id === 2)));
    assert.equal(await actor.$eval('[data-retake-line="2"]', node => node.disabled && !!node.closest('.switch-ui')), true);
    assert.equal(await actor.$eval('[data-retake-comment="2"]', node => node.readOnly), true);
    await waitFor(actor, () => document.querySelector('[data-retake-line="2"]').parentElement.dataset.tooltip === t('retake.moderatorOnly'));
    const target = await actor.evaluate(() => { const line = session.lines.find(line => line.id === 2); return { lineId: 2, audioUrl: line.audioUrl, retakeRevision: line.retakeRevision || 0, value: true, comment: 'Speak louder' }; });
    assert.equal((await call(actor, 'set_needs_retake', target)).reason, 'owner'); assert.equal((await call(other, 'set_needs_retake', target)).reason, 'owner');
    assert.equal((await call(host, 'set_needs_retake', target)).ok, true); await waitFor(actor, () => session.lines.find(line => line.id === 2).retakeComment === 'Speak louder');
    assert.equal(await actor.$eval('[data-retake-comment="2"]', node => node.value), 'Speak louder');
    await actor.evaluate(() => { const line = session.lines.find(line => line.id === 2), key = `dubline_retake_draft_v1:${encodeURIComponent(currentRoom)}:${session.activeSessionId}:${clientId}:2`; localStorage.setItem(key, JSON.stringify({ audioUrl: line.audioUrl, revision: 0, comment: 'Old unsaved author remark' })); });
    await actor.reload(); await waitFor(actor, () => session?.loaded && hasSceneMediaAccess()); await actor.evaluate(() => selectLine(session.lines.find(line => line.id === 2)));
    assert.equal(await actor.$eval('[data-retake-comment="2"]', node => node.value), 'Speak louder', 'a legacy unauthorized draft cannot hide the authoritative request reason');
    assert.equal((await host.evaluate(() => new Promise(resolve => socket.emit('host_grant_moderator', { nick: 'Other' }, resolve)))).ok, true); await waitFor(other, () => canModerate());
    assert.equal((await call(other, 'set_needs_retake', { ...target, value: false, comment: '', retakeRevision: target.retakeRevision + 1 })).ok, true);
    assert.equal((await call(host, 'set_needs_retake', target)).reason, 'conflict');
  });
  test('the shared dropdown handles mouse, arrows, Enter/Escape, disabled options and programmatic changes', async () => {
    await actor.evaluate(() => { DublineVoiceEditor.open(2, 'takes'); const select = document.createElement('select'); select.id = 'fxDropdownTest'; select.setAttribute('aria-label', 'Dropdown fixture'); select.replaceChildren(...DublineVoiceChain.TYPES.map(type => new Option(t('effect.' + type), type))); document.querySelector('#fxDialog .fx-sidebar').append(select); }); await waitFor(actor, () => !!DublineDropdown.button(document.getElementById('fxDropdownTest')));
    await actor.evaluate(() => DublineDropdown.button(document.getElementById('fxDropdownTest')).focus()); await actor.keyboard.press('ArrowDown');
    assert.equal(await actor.$eval('#dubSelectPopup', node => !node.hidden && !!node.closest('dialog[open]')), true);
    await actor.keyboard.press('Home'); await actor.keyboard.press('ArrowDown'); await actor.keyboard.press('Enter'); assert.equal(await actor.$eval('#fxDropdownTest', node => node.value), 'radio');
    await actor.evaluate(() => DublineDropdown.button(document.getElementById('fxDropdownTest')).click()); await actor.keyboard.press('Escape'); assert.equal(await actor.$eval('#fxDialog', node => node.open), true);
    await actor.evaluate(() => { document.getElementById('fxDropdownTest').value = 'echo'; }); await waitFor(actor, () => DublineDropdown.button(document.getElementById('fxDropdownTest')).textContent.includes(t('effect.echo')));
    await actor.evaluate(() => { document.getElementById('fxDropdownTest').options[0].disabled = true; DublineDropdown.button(document.getElementById('fxDropdownTest')).click(); }); await actor.keyboard.press('Home'); await actor.keyboard.press('Enter'); assert.notEqual(await actor.$eval('#fxDropdownTest', node => node.value), 'robot');
    await actor.evaluate(() => { document.getElementById('fxDropdownTest').options[0].disabled = false; DublineDropdown.button(document.getElementById('fxDropdownTest')).scrollIntoView({ block: 'nearest' }); DublineDropdown.button(document.getElementById('fxDropdownTest')).click(); }); await actor.locator('#dubSelectOptions [data-index="2"]').click(); assert.equal(await actor.$eval('#fxDropdownTest', node => node.value), 'telephone');
    await actor.evaluate(() => document.getElementById('fxDropdownTest').remove()); await closeFx(actor);
  });
  test('one-shot chain preview and unavailable samples do not prevent editing', async () => {
    await host.evaluate(() => DublineVoiceEditor.open('Hero', 'role')); assert.equal(await host.$eval('#fxLoop', node => node.checked), false);
    await waitFor(host, () => !document.getElementById('fxPlay').disabled); await host.click('#fxPlay'); await waitFor(host, () => document.getElementById('fxPlay').textContent === t('fx.play'), 6000); await closeFx(host);
    const added = await call(host, 'editor_add_track', { character: 'Empty' }); assert.equal(added.ok, true);
    await host.evaluate(() => DublineVoiceEditor.open('Empty', 'role')); await waitFor(host, () => document.getElementById('fxPlay').disabled && document.getElementById('fxPlay').parentElement.dataset.tooltip === t('fx.noSampleHelp'));
    assert.equal(await host.$eval('#fxAdd', node => node.disabled), false); await closeFx(host);
  });
  test('Save as preset captures a private role draft, broadcasts it, and survives discarding the role draft', async () => {
    await host.evaluate(() => DublineVoiceEditor.open('Hero', 'role')); await host.$eval('#fxPresets', node => { node.open = true; });
    for (const type of ['radio', 'robot', 'echo']) { await host.click('[data-fx-type="' + type + '"]'); }
    await host.$eval('#fxPitch', node => { node.value = '-2'; node.dispatchEvent(new Event('input')); });
    await host.click('#fxPresetSave'); await answerTextPrompt(host, 'Old radio'); await waitFor(actor, () => Object.values(session.voicePresets || {}).some(preset => preset.name === 'Old radio'));
    savedId = await actor.evaluate(() => Object.values(session.voicePresets).find(preset => preset.name === 'Old radio').id);
    await host.click('#fxCancel'); await waitFor(host, () => document.querySelector('dialog.text-prompt[open]'));
    await host.click('#textPromptContinue'); assert.equal(await host.$eval('#fxDialog', node => node.open), true); assert.equal(await host.$$eval('#fxRows .fx-item', nodes => nodes.length), 3);
    await host.click('#fxCancel'); await waitFor(host, () => document.querySelector('dialog.text-prompt[open]')); await host.click('#textPromptCancel'); await waitFor(host, () => !document.getElementById('fxDialog').open);
    assert.equal(await actor.evaluate(() => DublineVoiceChain.role(session, 'Hero').effects.length), 0);
    assert.equal(await actor.evaluate(id => session.voicePresets[id].effects.length, savedId), 3);
  });
  test('preset selection links one own chain and applies its complete settings without broadcasting the draft', async () => {
    await actor.evaluate(() => DublineVoiceEditor.open(2, 'takes')); await actor.select('#fxPresetSelect', savedId); await actor.click('#fxPresetApply');
    assert.equal(await actor.evaluate(() => session.lines.find(line => line.id === 2).voicePresetId || null), null);
    assert.equal(await actor.$$eval('#fxRows .fx-item', nodes => nodes.length), 3);
    await actor.click('#fxApply'); await waitFor(host, id => session.lines.find(line => line.id === 2).voicePresetId === id, 10000, savedId);
    assert.deepEqual(await actor.evaluate(() => session.lines.find(line => line.id === 2).effects), []);
    assert.equal(await actor.evaluate(() => DublineVoiceChain.resolve(session.lines.find(line => line.id === 2),session).pitch), -2);
  });
  test('editing preset pitch creates a private variant; Save on close commits only that chain', async () => {
    await actor.evaluate(() => DublineVoiceEditor.open(2, 'takes')); await actor.select('#fxPitchMode','override');
    await actor.$eval('#fxPitch', node => { node.value = '-1'; node.dispatchEvent(new Event('input')); }); await actor.click('#fxClose');
    await waitFor(actor, () => document.querySelector('dialog.text-prompt[data-kind=decision][open]')); await actor.click('#textPromptSave');
    await waitFor(host, () => session.lines.find(line => line.id === 2).pitch === -1 && session.lines.find(line => line.id === 2).presetModified === true);
    await waitFor(actor, () => !fxDialog.open); await actor.evaluate(() => DublineVoiceEditor.open(2,'takes')); await actor.click('#fxCancel'); assert.equal(await actor.$eval('#fxDialog',n=>n.open),false);
  });
  test('bulk preset replacement uses one shared chain per take and preserves unrelated settings', async () => {
    await host.evaluate(() => { multiSelection.clear(); multiSelection.add(1); multiSelection.add(2); DublineVoiceEditor.bulk(); }); await host.select('#fxPresetSelect',savedId); await host.click('#fxPresetApply');
    await waitFor(host,()=>textPrompt.open); await host.click('#textPromptSave'); await host.click('#fxApply'); await waitFor(host,()=>textPrompt.open); await host.click('#textPromptSave');
    await waitFor(actor,id=>session.lines.filter(line=>[1,2].includes(line.id)).every(line=>line.voicePresetId===id&&line.effects.length===0&&line.presetModified===false),10000,savedId);
    await host.evaluate(()=>multiSelection.clear());
  });
  test('combined resource limits refuse the entire preset draft without altering saved sound', async () => {
    await actor.evaluate(()=>DublineVoiceEditor.open(2,'takes')); for(let i=0;i<5;i++) await actor.click('[data-fx-type=cave]');
    const before=await actor.evaluate(()=>JSON.stringify(session.lines.find(line=>line.id===2))); await actor.click('#fxApply');
    await waitFor(actor,()=>document.getElementById('fxStatus').textContent===t('fx.limit')); assert.equal(await actor.evaluate(()=>JSON.stringify(session.lines.find(line=>line.id===2))),before); await closeFx(actor);
  });
 test('lost voice ACKs recover the original immutable operation and cannot lose a draft through close', async () => {
    const previous = await actor.evaluate(() => session.lines.find(line => line.id === 2).takeMixRevision);
    await actor.evaluate(() => { DublineVoiceEditor.open(2, 'takes'); const emit = socket.emit, onack = socket.onack, dropped = new Set(); window.fxRequests = [];
      window.restoreFxAck = () => { socket.emit = emit; socket.onack = onack; };
      socket.emit = function(event, ...args) { if (event === 'voice_update' && fxRequests.length < 2) { dropped.add(this.ids); fxRequests.push(args[0].operationId); } return emit.call(this, event, ...args); };
      socket.onack = function(packet) { if (dropped.delete(packet.id)) return; return onack.call(this, packet); };
    });
    try { await actor.$eval('#fxPitch', node => { node.value = '1'; node.dispatchEvent(new Event('input')); }); await actor.click('#fxApply'); await actor.click('#fxClose'); assert.equal(await actor.$eval('#fxDialog', node => node.open && node.querySelector('.fx-body').inert), true);
      await waitFor(actor, () => !document.getElementById('fxDialog').open, 18000); assert.equal(await actor.evaluate(() => new Set(fxRequests).size), 1); assert.equal(await actor.evaluate(() => fxRequests.length), 2);
      assert.equal(await actor.evaluate(() => session.lines.find(line => line.id === 2).takeMixRevision), previous + 1); assert.equal(await actor.evaluate(() => session.lines.find(line => line.id === 2).pitch), 1);
    } finally { await actor.evaluate(() => restoreFxAck()); }
  });
  test('lost preset ACKs confirm one saved snapshot through the receipt and never create duplicate presets', async () => {
    await host.evaluate(() => { DublineVoiceEditor.open('Hero', 'role'); const emit = socket.emit, onack = socket.onack, dropped = new Set(); window.presetRequests = [];
      window.restorePresetAck = () => { socket.emit = emit; socket.onack = onack; };
      socket.emit = function(event, ...args) { if (event === 'voice_preset_update' && presetRequests.length < 2) { dropped.add(this.ids); presetRequests.push(args[0].operationId); } return emit.call(this, event, ...args); };
      socket.onack = function(packet) { if (dropped.delete(packet.id)) return; return onack.call(this, packet); };
    });
    try { await host.$eval('#fxPresets', node => { node.open = true; }); await host.click('#fxPresetSave'); await answerTextPrompt(host, 'Lost ACK preset');
      await waitFor(host, () => document.getElementById('fxPresetStatus').textContent === t('preset.saved'), 18000);
      assert.equal(await host.evaluate(() => new Set(presetRequests).size), 1); assert.equal(await host.evaluate(() => presetRequests.length), 2);
      const copies = await host.evaluate(() => Object.values(session.voicePresets).filter(preset => preset.name === 'Lost ACK preset')); assert.equal(copies.length, 1); assert.equal(copies[0].revision, 1);
      assert.equal((await preset(host, { action: 'delete', id: copies[0].id, revision: 1 })).ok, true);
    } finally { await host.evaluate(() => restorePresetAck()); await closeFx(host); }
  });
  test('catalogue owner/moderator authorization, conflict refusal, independent updates and deletion leave applied takes unchanged', async () => {
    const entry = await host.evaluate(id => structuredClone(session.voicePresets[id]), savedId), before = await actor.evaluate(() => JSON.stringify(session.lines.find(line => line.id === 2)));
    assert.equal((await preset(actor, { action: 'rename', id: savedId, revision: 1, name: 'Forged' })).reason, 'preset.owner');
    assert.equal((await preset(host, { action: 'update', id: savedId, revision: 1, settings: { effects: [effect('new', 'telephone')], pitch: 4 } })).ok, true);
    assert.equal((await preset(host, { action: 'rename', id: savedId, revision: 1, name: 'Stale' })).reason, 'preset.conflict');
    await waitFor(actor, id => session.voicePresets[id]?.revision === 2, 10000, savedId); assert.equal(await actor.evaluate(() => JSON.stringify(session.lines.find(line => line.id === 2))), before);
    assert.equal((await preset(other, { action: 'delete', id: savedId, revision: 2, detach: true })).ok, true); await waitFor(actor, id => !Object.hasOwn(session.voicePresets, id), 10000, savedId);
    assert.equal(await actor.evaluate(() => session.lines.find(line => line.id === 2).voicePresetId), null);
    const created = await preset(actor, { action: 'create', id: 'actor-preset', revision: 0, name: 'Actor preset', settings: { effects: entry.effects, pitch: -2 } }); assert.equal(created.ok, true); savedId = 'actor-preset';
  });
  test('disk failures roll back without broadcast; repeated immutable operations return the original result', async () => {
    const blocker = path.join(server.dirs.data, 'rooms.json.tmp'); assert.ok(blocker.startsWith(server.dirs.data + path.sep)); fs.mkdirSync(blocker);
    try { assert.equal((await preset(actor, { action: 'rename', id: savedId, revision: 1, name: 'Failure' })).reason, 'preset.storage'); }
    finally { fs.rmdirSync(blocker); }
    assert.equal(await actor.evaluate(id => session.voicePresets[id].name, savedId), 'Actor preset');
    const duplicate = await actor.evaluate(async id => { const request = { sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now(), action: 'rename', id, revision: 1, name: 'Renamed actor preset' };
      const emit = () => new Promise(resolve => socket.emit('voice_preset_update', request, resolve)); const first = await emit(), second = await emit(); return { first, second };
    }, savedId); assert.equal(duplicate.first.ok, true); assert.deepEqual(duplicate.first, duplicate.second); assert.equal(duplicate.first.voicePresets[savedId].revision, 2);
  });
  test('nickname changes retain preset creator rights and newly admitted participants receive the current catalogue', async () => {
    assert.equal((await actor.evaluate(() => new Promise(resolve => socket.emit('rename_user', { newName: 'Actor renamed' }, resolve)))).ok, true);
    await waitFor(actor, id => myName === 'Actor renamed' && session.voicePresets[id]?.createdBy === myName, 10000, savedId);
    assert.equal((await preset(actor, { action: 'update', id: savedId, revision: 3, settings: { effects: [effect('renamed', 'radio')], pitch: -2 } })).ok, true);
    const late = await openPlayer(browser, server.url('ui-presets'), 'Late'); try { await waitFor(late, id => session?.voicePresets?.[id]?.revision === 4, 10000, savedId); assert.equal(await late.evaluate(id => session.voicePresets[id].createdBy, savedId), 'Actor renamed'); } finally { await late.close(); }
  });
  test('long dropdowns search dynamically updated options, place above a low anchor and retain keyboard focus', async () => {
    await actor.evaluate(() => { const select = document.createElement('select'); select.id = 'testLongSelect'; select.setAttribute('aria-label', 'Roles'); select.style.position = 'fixed'; select.style.bottom = '8px'; select.style.left = '20px'; document.body.append(select); for (let i = 0; i < 30; i++) select.add(new Option('Role ' + i, 'r' + i)); });
    await waitFor(actor, () => !!DublineDropdown.button(document.getElementById('testLongSelect'))); await actor.evaluate(() => { const button = DublineDropdown.button(document.getElementById('testLongSelect')); button.style.position = 'fixed'; button.style.bottom = '8px'; button.style.left = '20px'; button.click(); });
    assert.equal(await actor.$eval('.dub-select-search', node => node.hidden), false); await actor.type('.dub-select-search', 'Role 29'); assert.equal(await actor.$$eval('#dubSelectOptions [role=option]', nodes => nodes.length), 1);
    await actor.keyboard.press('Enter'); assert.equal(await actor.$eval('#testLongSelect', node => node.value), 'r29');
    await actor.evaluate(() => DublineDropdown.button(document.getElementById('testLongSelect')).click()); assert.equal(await actor.$eval('#dubSelectPopup', node => node.getBoundingClientRect().bottom <= innerHeight), true);
    await actor.keyboard.press('Tab'); assert.equal(await actor.$eval('#dubSelectPopup', node => node.hidden), true);
    await actor.evaluate(() => document.getElementById('testLongSelect').remove());
  });
  test('a dropdown inside the role picker remains inside its surface and can apply an individual line override', async () => {
    await actor.select('#timelineScopeFilter', 'choose'); await actor.click('#timelineChooseFilter');
    await actor.evaluate(() => DublineDropdown.button(document.getElementById('timelineLineFilter')).click());
    assert.equal(await actor.$eval('#dubSelectPopup', node => !node.hidden && document.getElementById('timelineFilterPicker').contains(node)), true);
    const index = await actor.$eval('#timelineLineFilter', select => [...select.options].findIndex(option => option.value === '4'));
    await actor.locator('#dubSelectOptions [data-index="' + index + '"]').click(); assert.equal(await actor.$eval('#timelineFilterPicker', node => node.hidden), false);
    await actor.click('#timelineFilterPicker [data-filter-action=include]'); assert.ok(await actor.evaluate(() => DublineTimelineFilters.ids().includes(4)));
    await actor.select('#timelineScopeFilter', 'all');
  });
  test('localized preview status stays consistent when preparation completes between browser reads', async () => {
    const language = await actor.evaluate(() => DublineI18n.getLanguage());
    try {
      await actor.evaluate(() => {
        window.qaOriginalStartRendering = OfflineAudioContext.prototype.startRendering;
        window.qaPreviewGate = new Promise(resolve => { window.qaReleasePreview = resolve; });
        window.qaPreviewHeld = false;
        OfflineAudioContext.prototype.startRendering = async function(...args) {
          const result = await qaOriginalStartRendering.apply(this, args);
          qaPreviewHeld = true; await qaPreviewGate;
          return result;
        };
        DublineVoiceEditor.open(2, 'takes');
      });
      await actor.click('[data-fx-type=radio]');
      await waitFor(actor, () => qaPreviewHeld && document.getElementById('fxStatus').dataset.i18n === 'fx.processing');
      await actor.evaluate(() => DublineI18n.setLanguage('uk'));
      const preparing = await localizedStatus(actor);
      assert.equal(preparing.key, 'fx.processing'); assert.equal(preparing.actual, preparing.expected);
      // Finish real processing exactly between the two reads the old assertion
      // made. No status DOM or translated text is replaced by the fixture.
      await actor.evaluate(() => qaReleasePreview());
      await waitFor(actor, () => document.getElementById('fxStatus').dataset.i18n === 'fx.ready');
      const ready = await localizedStatus(actor);
      assert.equal(ready.key, 'fx.ready'); assert.equal(ready.actual, ready.expected);
      assert.notEqual(preparing.actual, ready.expected, 'mixing the two reads reproduces the previous false failure');
    } finally {
      await actor.evaluate(async language => {
        window.qaReleasePreview?.();
        if (window.qaOriginalStartRendering) OfflineAudioContext.prototype.startRendering = qaOriginalStartRendering;
        await DublineI18n.setLanguage(language);
        for (const name of ['qaReleasePreview', 'qaOriginalStartRendering', 'qaPreviewGate', 'qaPreviewHeld']) delete window[name];
      }, language);
      await closeFx(actor);
    }
  });
  test('six themes, three locales, long names and 150% narrow dialogs keep popup, focus and footer usable', async () => {
    await actor.setViewport({ width: 640, height: 850 }); await actor.evaluate(() => DublineVoiceEditor.open(2, 'takes')); await waitFor(actor, () => document.getElementById('fxDialog').open); await waitFor(actor, () => !!document.getElementById('fxStatus').dataset.i18n);
    for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
      await actor.evaluate(async (theme, language) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); document.body.style.zoom = '150%'; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); DublineDropdown.button(document.getElementById('fxPresetSelect')).click(); }, theme, language);
      await waitFor(actor, () => { const button = getComputedStyle(DublineDropdown.button(document.getElementById('fxPresetSelect'))), dialog = getComputedStyle(document.getElementById('fxDialog')); return button.backgroundColor === dialog.backgroundColor && button.color === dialog.color; });
      const status = await localizedStatus(actor);
      assert.ok(status.key); assert.equal(status.actual, status.expected);
      const contrast = await actor.evaluate(() => { const css = getComputedStyle(document.getElementById('dubSelectPopup')); const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0); const a = luminance(css.color), b = luminance(css.backgroundColor); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }); assert.ok(contrast >= 4.5, JSON.stringify({ theme, language, contrast }));
      const geometry = await actor.evaluate(() => { const popup = document.getElementById('dubSelectPopup').getBoundingClientRect(), dialog = document.getElementById('fxDialog').getBoundingClientRect(), apply = document.getElementById('fxApply').getBoundingClientRect(); return { fits: popup.width > 0 && popup.left >= 0 && popup.right <= innerWidth + 1 && popup.top >= 0 && popup.bottom <= innerHeight + 1, footer: apply.height > 0 && apply.top >= dialog.top && apply.bottom <= dialog.bottom, overflow: fxDialog.scrollWidth > fxDialog.clientWidth + 1 }; });
      assert.ok(geometry.fits && geometry.footer && !geometry.overflow, JSON.stringify({ theme, language, geometry })); await actor.keyboard.press('Escape');
      await actor.evaluate(id => { document.getElementById('fxPresets').open = true; const select = document.getElementById('fxPresetSelect'); select.value = id; select.selectedOptions[0].textContent = ('Длинное название пресета · ').repeat(4).slice(0, 80); }, savedId);
      await waitFor(actor, () => DublineDropdown.button(document.getElementById('fxPresetSelect')).textContent.length >= 80);
      await actor.evaluate(() => DublineDropdown.button(document.getElementById('fxPresetSelect')).click());
      const named = await actor.evaluate(() => { const popup = document.getElementById('dubSelectPopup').getBoundingClientRect(), dialog = document.getElementById('fxDialog').getBoundingClientRect(), apply = document.getElementById('fxApply').getBoundingClientRect(); return { fits: popup.width > 0 && popup.left >= 0 && popup.right <= innerWidth + 1 && popup.top >= 0 && popup.bottom <= innerHeight + 1, footer: apply.height > 0 && apply.top >= dialog.top && apply.bottom <= dialog.bottom, overflow: fxDialog.scrollWidth > fxDialog.clientWidth + 1 }; });
      assert.ok(named.fits && named.footer && !named.overflow, JSON.stringify({ theme, language, named })); await actor.keyboard.press('Escape');
    }
    await actor.evaluate(async () => { document.documentElement.dataset.theme = 'light'; await DublineI18n.setLanguage('ru'); }); await waitFor(actor, () => getComputedStyle(DublineDropdown.button(document.getElementById('fxPresetSelect'))).backgroundColor === 'rgb(255, 255, 255)'); await actor.screenshot({ path: path.join(__dirname, '../audit/ui-presets/dialog-light.png') }); await closeFx(actor); await actor.evaluate(() => { document.body.style.zoom = ''; }); await actor.setViewport({ width: 1600, height: 900 });
  });
  test('portable format 13 reopens only the scene catalogue, survives host restart, and preserves recordings', async () => {
    const bytes = await host.evaluate(async () => { const barrier = await prepareSafeSnapshot('project'), response = await fetch('/api/export-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, ...barrier }) }); if (!response.ok) throw Error(await response.text()); return Array.from(new Uint8Array(await response.arrayBuffer())); }); projectBytes = bytes;
    const read = require('../server/projects').readProject(Buffer.from(bytes)); assert.equal(read.manifest.formatVersion, 13); assert.equal(read.manifest.project.voicePresets[savedId].revision, 4);
    const old = await host.evaluate(() => session.activeSessionId);
    await host.evaluate(async bytes => { const form = new FormData(); form.append('clientId', clientId); form.append('sessionId', session.activeSessionId); form.append('project', new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), 'presets.dubline'); const response = await fetch('/api/import-project?room=' + encodeURIComponent(currentRoom), { method: 'POST', body: form }); if (!response.ok) throw Error(await response.text()); }, projectBytes);
    await waitFor(actor, old => session.activeSessionId !== old && Object.keys(session.voicePresets || {}).length === 1, 20000, old);
    await server.restart(); await waitFor(actor, () => socket.connected && hasSceneMediaAccess() && session.voicePresets?.['actor-preset']?.name === 'Renamed actor preset', 20000);
    const current = await actor.evaluate(async () => Array.from(new Uint8Array(await (await fetch(session.lines.find(line => line.id === 2).audioUrl)).arrayBuffer())));
    assert.equal(crypto.createHash('sha256').update(Buffer.from(current)).digest('hex'), crypto.createHash('sha256').update(Buffer.from(originalHash)).digest('hex'));
    const preservedScene = await actor.evaluate(() => session.activeSessionId); await loadFixture(host); await waitFor(actor, id => session.activeSessionId !== id && Object.keys(session.voicePresets || {}).length === 0, 15000, preservedScene);
    await waitFor(host, () => socket.connected && hasSceneMediaAccess());
    await host.evaluate(id => switchSession(id), preservedScene);
    try { await waitFor(actor, id => session.activeSessionId === id && Object.keys(session.voicePresets || {}).length === 1, 15000, preservedScene); }
    catch (error) { console.error('Scene return diagnostics', JSON.stringify({ preservedScene, host: await host.evaluate(() => ({ active: session.activeSessionId, catalog: Object.keys(session.voicePresets || {}), connected: socket.connected, host: amHost(), frozen: snapshotFrozen, scenes: session.sessionList.map(item => item.id), toast: document.getElementById('toast').textContent })), actor: await actor.evaluate(() => ({ active: session.activeSessionId, catalog: Object.keys(session.voicePresets || {}) })), server: server.log.split('\n').slice(-10) })); throw error; }
    const fresh = await openPlayer(browser, server.url('another-room'), 'Fresh'); await loadFixture(fresh); assert.equal(await fresh.evaluate(() => Object.keys(session.voicePresets || {}).length), 0); await fresh.close();
  });
  test('no unhandled browser errors', () => { assert.deepEqual(host.errors, []); assert.deepEqual(actor.errors, []); assert.deepEqual(other.errors, []); });
});
