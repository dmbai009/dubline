const { describe, test, before, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor } = require('./helpers');

describe('Role presets, bulk assignment and spatial Shift selection', { skip: skipReason }, () => {
  let server, browser, host, actor, other, heroId;
  const call = (page, event, data) => page.evaluate((event, data) => new Promise(resolve => socket.emit(event, { ...data, sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() }, resolve)), event, data);
  const close = page => page.evaluate(() => DublineVoiceEditor.close(true));
  const roleName = async (page, name) => { await waitFor(page, () => textPrompt.open && textPrompt.dataset.kind === 'text'); await page.$eval('#textPromptInput', (node, value) => { node.value = value; }, name); await page.click('#textPromptSave'); await waitFor(page, () => textPrompt.open && textPrompt.dataset.kind === 'confirm'); };
  const select = (page, ids) => page.evaluate(ids => { multiSelection.clear(); ids.forEach(id => multiSelection.add(id)); refreshMultiSelection(); }, ids);
  async function record(page, id) {
    await page.evaluate(async id => {
      const buffer = new AudioBuffer({ length: 24000, sampleRate: 48000, numberOfChannels: 1 });
      for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = .05 * Math.sin(i * .1);
      await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: id, nick: myName, audioStart: 0, duration: .5, trimStart: .05, trimEnd: .4, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() });
    }, id);
    await waitFor(page, id => !!session.lines.find(line => line.id === id).audioUrl, 10000, id);
  }
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url('role-workflow'), 'Host', { autoConfirm: false }); await loadFixture(host);
    actor = await openPlayer(browser, server.url('role-workflow'), 'Actor', { autoConfirm: false }); other = await openPlayer(browser, server.url('role-workflow'), 'Other', { autoConfirm: false });
    await waitFor(actor, () => session.loaded); await waitFor(other, () => session.loaded);
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('real Shift clicks keep the original anchor, select a single track or a rectangle in both modes', async () => {
    for (const mode of ['dub', 'edit']) {
      await host.evaluate(mode => socket.emit('set_session_mode', { mode, sessionId: session.activeSessionId }), mode); await waitFor(host, mode => session.mode === mode, 10000, mode);
      await host.click('#line-block-1'); await host.keyboard.down('Shift'); await host.click('#line-block-3'); await host.keyboard.up('Shift');
      assert.deepEqual(await host.evaluate(() => [...multiSelection].sort()), [1, 3]);
      await host.keyboard.down('Shift'); await host.click('#line-block-2'); await host.keyboard.up('Shift');
      assert.deepEqual(await host.evaluate(() => [...multiSelection].sort()), [1, 2]);
      await host.keyboard.down('Shift'); await host.click('#line-block-4'); await host.keyboard.up('Shift');
      assert.deepEqual(await host.evaluate(() => [...multiSelection].sort()), [1, 2, 3, 4]);
    }
    await host.evaluate(() => { clearMultiSelection(); socket.emit('set_session_mode', { mode: 'dub', sessionId: session.activeSessionId }); });
    await Promise.all([waitFor(host, () => session.mode === 'dub'), waitFor(actor, () => session.mode === 'dub')]);
  });
  test('Shift selection starts a new anchor when a personal filter hides the previous one', async () => {
    await host.locator('#line-block-1').click(); await host.select('#timelineScopeFilter', 'choose');
    await host.locator('#timelineChooseFilter').click(); await host.locator('[data-filter-role="Friend"]').click(); await host.locator('#timelineChooseFilter').click();
    await host.keyboard.down('Shift'); await host.locator('#line-block-2').click(); await host.locator('#line-block-4').click(); await host.keyboard.up('Shift');
    assert.deepEqual(await host.evaluate(() => [...multiSelection].sort()), [2, 4]);
    await host.select('#timelineScopeFilter', 'all'); await host.evaluate(() => clearMultiSelection());
  });
  test('the role owner can Apply directly, creating one named shared preset for existing and future lines', async () => {
    await actor.evaluate(() => claimCharacter('Hero')); await waitFor(host, () => session.characterClaims.Hero === 'Actor'); await record(actor, 1);
    const original = await actor.evaluate(async () => [...new Uint8Array(await (await fetch(session.lines[0].audioUrl)).arrayBuffer())]);
    assert.equal(await actor.$$eval('.track-fx', nodes => nodes.length), 1); assert.equal(await other.$$eval('.track-fx', nodes => nodes.length), 0);
    await actor.evaluate(() => DublineVoiceEditor.open('Hero', 'role')); await actor.click('[data-fx-type=radio]'); await actor.click('#fxApply');
    await waitFor(actor, () => textPrompt.open); assert.ok(await actor.$eval('#textPromptTitle', node => node.textContent.includes('Hero'))); await actor.click('#textPromptSave');
    await waitFor(host, () => Object.values(session.voicePresets).some(preset => preset.name === 'Hero') && session.roleEffects.Hero?.voicePresetId);
    await waitFor(actor, () => !fxDialog.open);
    heroId = await host.evaluate(() => session.roleEffects.Hero.voicePresetId);
    assert.deepEqual(await other.evaluate(() => [1, 3].map(id => DublineVoiceChain.resolve(session.lines.find(line => line.id === id), session).effects.map(e => e.type))), [['radio'], ['radio']]);
    assert.deepEqual(await actor.evaluate(async () => [...new Uint8Array(await (await fetch(session.lines[0].audioUrl)).arrayBuffer())]), original);
  });
  test('reapplying a role edits its existing named preset; another participant cannot write it', async () => {
    await actor.evaluate(() => DublineVoiceEditor.open('Hero', 'role')); await actor.$eval('[data-action=amount]', node => { node.value = 25; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await actor.click('#fxApply'); await waitFor(actor, () => textPrompt.open); await actor.click('#textPromptSave'); await waitFor(actor, () => !fxDialog.open);
    await waitFor(host, id => session.voicePresets[id]?.revision === 2, 10000, heroId);
    assert.equal(await host.evaluate(() => Object.values(session.voicePresets).filter(p => p.name === 'Hero').length), 1);
    assert.equal((await call(other, 'voice_preset_update', { action: 'update', id: heroId, revision: 2, settings: { effects: [] } })).reason, 'preset.owner');
    const denied = await other.evaluate(() => ({ scope: 'role', character: 'Hero', revision: session.roleEffects.Hero.revision, previousPresetRevision: session.voicePresets[session.roleEffects.Hero.voicePresetId].revision, settings: { pitch: 0, effects: [] } }));
    assert.equal((await call(other, 'voice_update', denied)).reason, 'fx.owner');
  });
  test('bulk inspector applies a linked preset atomically only to eligible selected lines, including future recordings', async () => {
    assert.equal((await call(host, 'voice_preset_update', { action: 'create', id: 'phone', name: 'Phone', revision: 0, settings: { effects: [{ id: 'phone-stage', type: 'telephone', enabled: true, amount: .5, parameters: {} }] } })).ok, true);
    await select(actor, [1, 2, 3]);
    assert.ok(await actor.$eval('[data-preset-lines] label', node => node.textContent.includes('2 of 3')));
    await actor.select('#inspectorPreset', 'phone'); await actor.click('[data-preset-apply]'); await waitFor(actor, () => textPrompt.open); await actor.click('#textPromptSave');
    await waitFor(other, () => [1, 3].every(id => session.lines.find(line => line.id === id).voicePresetId === 'phone'));
    assert.equal(await host.evaluate(() => session.lines.find(line => line.id === 2).voicePresetId), null);
    await record(actor, 3); assert.equal(await actor.evaluate(() => session.lines.find(line => line.id === 3).voicePresetId), 'phone');
    await select(host, [2, 4]); await host.select('#inspectorPreset', 'phone'); await host.click('[data-preset-apply]'); await waitFor(host, () => textPrompt.open); await host.click('#textPromptSave');
    await waitFor(other, () => session.lines.every(line => line.voicePresetId === 'phone'));
  });
  test('a role-name collision warns before creation; cancellation is harmless and confirmation binds the role', async () => {
    await host.evaluate(() => { clearMultiSelection(); DublineVoiceEditor.open(2, 'takes'); }); await host.click('[data-fx-type=echo]');
    const before = await host.evaluate(() => JSON.stringify([session.voicePresets, session.roleEffects]));
    await host.click('#fxPresetSave'); await roleName(host, 'Friend');
    assert.ok(await host.$eval('#textPromptTitle', node => node.textContent.includes('Friend') && node.textContent.includes('role'))); await host.click('#textPromptCancel');
    assert.equal(await host.evaluate(() => JSON.stringify([session.voicePresets, session.roleEffects])), before);
    await host.click('#fxPresetSave'); await roleName(host, 'Friend'); await host.click('#textPromptSave');
    await waitFor(other, () => Object.values(session.voicePresets).some(preset => preset.name === 'Friend') && session.roleEffects.Friend?.voicePresetId);
    await close(host);
  });
  test('server refuses forged role-name confirmation and lost ownership, and rolls back both role and catalogue on disk failure', async () => {
    const bad = { action: 'create', id: 'forged', name: 'Hero', revision: 0, settings: { effects: [] } };
    assert.equal((await call(other, 'voice_preset_update', bad)).reason, 'preset.owner');
    const before = await host.evaluate(() => JSON.stringify([session.voicePresets, session.roleEffects]));
    const request = await actor.evaluate(() => ({ scope: 'role', character: 'Hero', revision: session.roleEffects.Hero.revision, previousPresetRevision: session.voicePresets[session.roleEffects.Hero.voicePresetId].revision, settings: { pitch: 0, effects: [] }, rolePreset: { id: session.roleEffects.Hero.voicePresetId, revision: session.voicePresets[session.roleEffects.Hero.voicePresetId].revision } }));
    const blocker = path.join(server.dirs.data, 'rooms.json.tmp'); fs.mkdirSync(blocker);
    try { assert.equal((await call(actor, 'voice_update', request)).reason, 'fx.storage'); } finally { fs.rmdirSync(blocker); }
    assert.equal(await host.evaluate(() => JSON.stringify([session.voicePresets, session.roleEffects])), before);
    await actor.evaluate(id => DublineVoiceEditor.open(id, 'preset'), heroId); assert.equal(await actor.$eval('#fxDialog', node => node.open), true);
    await host.evaluate(() => unclaimCharacter('Hero')); await waitFor(actor, () => !session.characterClaims.Hero);
    await waitFor(actor, () => !fxDialog.open);
    assert.equal((await call(actor, 'voice_update', request)).reason, 'fx.owner');
    await actor.evaluate(() => DublineVoiceEditor.open('Hero', 'role')); assert.equal(await actor.$eval('#fxDialog', node => node.open), false);
  });
  test('a new role owner can update the previous owner’s role preset without gaining access to other roles', async () => {
    await other.evaluate(() => claimCharacter('Hero')); await waitFor(host, () => session.characterClaims.Hero === 'Other');
    await other.evaluate(() => DublineVoiceEditor.open('Hero', 'role')); assert.equal(await other.$eval('#fxDialog', node => node.open), true);
    await other.$eval('[data-action=amount]', node => { node.value = 35; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await other.click('#fxApply'); await waitFor(other, () => textPrompt.open); await other.click('#textPromptSave'); await waitFor(other, () => !fxDialog.open);
    await waitFor(host, id => session.voicePresets[id]?.effects[0]?.amount === .35, 10000, heroId);
    assert.equal(await host.evaluate(id => session.voicePresets[id].createdBy, heroId), 'Actor');
    await other.evaluate(() => DublineVoiceEditor.open('Friend', 'role')); assert.equal(await other.$eval('#fxDialog', node => node.open), false);
  });
  test('replaying a role publication updates the preset once; a stale bulk member prevents the whole write', async () => {
    const replay = await other.evaluate(async () => {
      const role = DublineVoiceChain.role(session, 'Hero'), preset = session.voicePresets[role.voicePresetId];
      const data = { scope: 'role', character: 'Hero', settings: role, revision: role.revision, previousPresetRevision: preset.revision, presetRevision: preset.revision, rolePreset: { id: preset.id, revision: preset.revision }, sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() };
      const emit = () => new Promise(resolve => socket.emit('voice_update', data, resolve));
      const first = await emit(), second = await emit();
      return { first, second, before: preset.revision, after: session.voicePresets[preset.id].revision, roleBefore: role.revision, roleAfter: session.roleEffects.Hero.revision };
    });
    assert.equal(replay.first.ok, true); assert.equal(replay.second.ok, true);
    assert.equal(replay.after, replay.before + 1); assert.equal(replay.roleAfter, replay.roleBefore + 1);
    const before = await host.evaluate(() => JSON.stringify(session.lines));
    const data = await host.evaluate(() => ({ scope: 'takes', action: 'detach', takes: session.lines.slice(0, 2).map((line, i) => ({ lineId: line.id, character: line.character, audioUrl: line.audioUrl, takeId: line.takeId || null, takeMixRevision: (line.takeMixRevision || 0) + i, presetRevision: session.voicePresets[line.voicePresetId].revision })) }));
    assert.equal((await call(host, 'voice_update', data)).reason, 'fx.conflict');
    assert.equal(await host.evaluate(() => JSON.stringify(session.lines)), before);
  });
  test('project round trip and restart retain named role links and bulk preset links', async () => {
    const bytes = await host.evaluate(async () => { const snapshot = await prepareSafeSnapshot('project'); const response = await fetch('/api/export-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, ...snapshot }) }); if (!response.ok) throw Error(await response.text()); return [...new Uint8Array(await response.arrayBuffer())]; });
    const read = require('../server/projects').readProject(Buffer.from(bytes)); assert.equal(read.manifest.project.roleEffects.Hero.voicePresetId, heroId); assert.equal(read.manifest.project.lines.every(line => line.take.voicePresetId === 'phone'), true);
    await server.restart(); await waitFor(host, () => socket.connected && hasSceneMediaAccess() && session.roleEffects.Hero?.voicePresetId);
    assert.equal(await host.evaluate(id => session.roleEffects.Hero.voicePresetId === id && session.lines.every(line => line.voicePresetId === 'phone'), heroId), true);
    for (const page of [host, actor, other]) assert.deepEqual(page.errors, []);
  });
});
