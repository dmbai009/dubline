const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-live-unit-'));
for (const [key, folder] of [['DATA', 'data'], ['UPLOAD', 'uploads'], ['PACKS', 'packs']]) { fs.mkdirSync(path.join(root, folder)); process.env['DUBLINE_' + key + '_DIR'] = path.join(root, folder); }
after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'dubline-live-unit-'))); fs.rmSync(root, { recursive: true, force: true }); });
const chain = require('./public/voice-chain-model'), presets = require('./public/voice-preset-model'), server = require('./server/voicePresets'), voices = require('./server/voiceChains'), projects = require('./server/projects'), history = require('./public/take-history-model');
const effect = (id, type = 'radio', amount = .8) => ({ id, type, enabled: true, amount, parameters: {} });
let sequence = 0; const newId = () => 'own' + ++sequence;
const entry = () => ({ id: 'phone', name: 'Phone', createdBy: 'Author', revision: 1, effects: [effect('telephone', 'telephone')], pitch: -2 });
const take = (id = 1) => ({ id, character: 'Role', start: 1, end: 2, audioUrl: '/uploads/take.wav', recordedBy: 'Other', pitch: 4, effects: [effect('individual')], pitchMode: 'inherit', inheritRoleEffects: true, excludedRoleEffectIds: [], takeHistory: [], takeId: 'take' + id });
const scene = () => ({ loaded: true, title: 'Linked', kind: 'custom', mode: 'dub', trackOrder: ['Role'], characterClaims: {}, roleEffects: { Role: { pitch: 3, effects: [effect('inherited', 'robot')], revision: 0 } }, voicePresets: { phone: entry() }, lines: [take()], videoUrl: '/uploads/scene.mp4', videoHasAudio: false });

test('explicit links stay live, preserve inheritance and opt into preset pitch separately', () => {
  const room = scene(), original = structuredClone(room.lines[0]);
  const linked = presets.link(original, room, 'phone');
  assert.equal(linked.voicePresetId, 'phone'); assert.deepEqual(linked.effects, []); assert.equal(linked.usePresetPitch, false);
  assert.deepEqual(chain.resolve(linked, room).effects.map(item => item.type), ['robot', 'telephone']); assert.equal(chain.resolve(linked, room).pitch, 3);
  room.voicePresets.phone.effects[0].amount = .6; room.voicePresets.phone.pitch = -5;
  assert.equal(chain.resolve(linked, room).effects[1].amount, .6); assert.equal(chain.resolve(linked, room).pitch, 3);
  assert.equal(chain.resolve(presets.link(original, room, 'phone', true), room).pitch, -5); assert.deepEqual(room.lines[0], original);
});
test('role, preset and individual stages have an unambiguous order and inherited exceptions', () => {
  const room = scene(); room.roleEffects.Role = { pitch: 1, effects: [effect('roleOwn', 'robot')], voicePresetId: 'phone', usePresetPitch: true };
  const linked = { ...take(), voicePresetId: 'phone', usePresetPitch: false, excludedRoleEffectIds: ['telephone'] };
  assert.deepEqual(chain.resolve(linked, room).effects.map(item => item.id), ['roleOwn', 'telephone', 'individual']); assert.equal(chain.resolve(linked, room).pitch, -2);
  voices.validateScene({ ...room, lines: [linked] });
});
test('preset revision updates affect foreign linked takes and history, while old copies remain independent', () => {
  const room = scene(); room.lines[0] = presets.link(take(), room, 'phone', true); room.lines[0].takeHistory = [{ ...presets.link(take(), room, 'phone', true), id: 'old' }];
  room.lines.push(presets.apply(take(2), room, entry(), { newId })); const before = structuredClone(room);
  const next = server.planScene(room, { nick: 'Author' }, { action: 'update', id: 'phone', revision: 1, settings: { effects: [effect('telephone', 'telephone', .3)], pitch: -4 } }, false);
  assert.equal(chain.resolve(next.lines[0], next).effects[1].amount, .3); assert.equal(chain.resolve(next.lines[0].takeHistory[0], next).pitch, -4);
  assert.equal(chain.resolve(next.lines[1], next).effects[1].amount, .8); assert.deepEqual(room, before);
  assert.throws(() => server.planScene(room, { nick: 'Other' }, { action: 'update', id: 'phone', revision: 1, settings: { effects: [] } }, false), /preset.owner/);
});
test('unsafe preset changes are rejected atomically including a dependent historical variant', () => {
  const room = scene(); room.lines[0].takeHistory = [{ ...presets.link(take(), room, 'phone'), effects: Array.from({ length: 6 }, (_, i) => effect('old' + i)), id: 'old' }];
  const before = structuredClone(room);
  assert.throws(() => server.planScene(room, { nick: 'Author' }, { action: 'update', id: 'phone', revision: 1, settings: { effects: [effect('a'), effect('b')] } }, false), /preset.limit/); assert.deepEqual(room, before);
});
test('detach freezes current sound and pitch without retaining a reference or changing original audio', () => {
  const room = scene(), linked = presets.link(take(), room, 'phone', true), before = chain.key(chain.resolve(linked, room));
  const detached = presets.detach(linked, room, newId); assert.equal(detached.voicePresetId, null); assert.equal(detached.pitchMode, 'override'); assert.equal(detached.audioUrl, linked.audioUrl);
  assert.notEqual(detached.effects[0].id, entry().effects[0].id); assert.equal(chain.key(chain.resolve(detached, room)), before);
  room.voicePresets.phone.pitch = 9; room.voicePresets.phone.effects = []; assert.equal(chain.key(chain.resolve(detached, room)), before);
});
test('used deletion requires explicit detach and freezes active, historical and trashed links in one plan', () => {
  const room = scene(); room.lines[0] = presets.link(take(), room, 'phone', true); room.lines[0].takeHistory = [{ ...presets.link(take(), room, 'phone', true), id: 'old' }];
  room.deletedLines = [{ lines: [{ line: presets.link(take(3), room, 'phone', true) }] }]; const sound = chain.key(chain.resolve(room.lines[0], room));
  assert.throws(() => server.planScene(room, { nick: 'Author' }, { action: 'delete', id: 'phone', revision: 1 }, false), /preset.inUse/);
  const next = server.planScene(room, { nick: 'Author' }, { action: 'delete', id: 'phone', revision: 1, detach: true }, false);
  assert.equal(next.voicePresets.phone, undefined); assert.equal(next.lines[0].voicePresetId, null); assert.equal(next.lines[0].takeHistory[0].voicePresetId, null); assert.equal(next.lines[0].takeHistory[0].character, undefined);
  assert.equal(next.deletedLines[0].lines[0].line.voicePresetId, null); assert.equal(chain.key(chain.resolve(next.lines[0], next)), sound); assert.equal(next.lines[0].takeMixRevision, 1);
});
test('detaching a role preset preserves inherited exclusions and role pitch', () => {
  const room = scene(); room.roleEffects.Role.voicePresetId = 'phone'; room.roleEffects.Role.usePresetPitch = true; room.lines[0].excludedRoleEffectIds = ['telephone'];
  const before = chain.key(chain.resolve(room.lines[0], room)); const next = server.planScene(room, { nick: 'Host' }, { action: 'delete', id: 'phone', revision: 1, detach: true }, true);
  assert.equal(next.roleEffects.Role.voicePresetId, null); assert.equal(chain.key(chain.resolve(next.lines[0], next)), before);
});
test('bulk assignment and detach enforce author identity, revisions and one atomic ownership result', () => {
  const room = scene(); room.lines = [take(1), take(2)]; const targets = room.lines.map(line => ({ lineId: line.id, character: line.character, audioUrl: line.audioUrl, takeId: line.takeId, takeMixRevision: 0 }));
  const request = { scope: 'takes', action: 'replace', takes: targets, settings: chain.take(presets.link(take(), room, 'phone', true)), presetRevision: 1, editPreset: true };
  assert.throws(() => voices.plan(room, { nick: 'Stranger' }, request, false, () => null), /fx.owner/);
  const next = voices.plan(room, { nick: 'Other' }, request, false, () => null); assert.equal(next.lines.length, 2); assert.ok(next.lines.every(line => line.voicePresetId === 'phone'));
  room.lines = next.lines; const detach = { scope: 'takes', action: 'detach', takes: room.lines.map(line => ({ lineId: line.id, character: line.character, audioUrl: line.audioUrl, takeId: line.takeId, takeMixRevision: 1, presetRevision: 1 })) };
  const cleared = voices.plan(room, { nick: 'Other' }, detach, false, () => null); assert.ok(cleared.lines.every(line => line.voicePresetId === null)); assert.notEqual(cleared.lines[0].effects[0].id, cleared.lines[1].effects[0].id);
  detach.takes[1].presetRevision = 0; assert.throws(() => voices.plan(room, { nick: 'Other' }, detach, false, () => null), /fx.conflict/);
});
test('history activation retains explicit preset links and missing runtime IDs safely fall back', () => {
  const room = scene(), line = presets.link(take(), room, 'phone', true); line.takeId = 'history'; const saved = history.extract(line), restored = take(); history.activate(restored, saved);
  assert.equal(restored.voicePresetId, 'phone'); assert.equal(chain.resolve(restored, room).pitch, -2); delete room.voicePresets.phone;
  assert.doesNotThrow(() => chain.resolve(restored, room)); assert.throws(() => voices.validateScene({ ...room, lines: [restored] }), /fx.limit/);
});
test('format 11 preserves 420 explicit links and history; format 10 cannot smuggle links or relink copies', async () => {
  fs.writeFileSync(path.join(root, 'uploads', 'scene.mp4'), Buffer.from('synthetic-video')); fs.writeFileSync(path.join(root, 'uploads', 'take.wav'), Buffer.from('synthetic-take'));
  const room = scene(); room.lines = Array.from({ length: 420 }, (_, i) => ({ ...presets.link(take(i + 1), room, 'phone', true), caption: '', claimedBy: null }));
  room.lines[0].takeHistory = [{ ...history.extract({ ...room.lines[0], takeId: 'historical' }), audioUrl: '/uploads/old.wav', archivedAt: 1 }]; fs.writeFileSync(path.join(root, 'uploads', 'old.wav'), Buffer.from('historical-take'));
  const archived = projects.readProject((await projects.exportProject(room)).buffer); assert.equal(archived.manifest.formatVersion, 11); assert.equal(archived.manifest.project.lines.filter(line => line.take.voicePresetId === 'phone').length, 420);
  const corrupted = structuredClone(archived.manifest); corrupted.formatVersion = 10; assert.throws(() => projects.validateManifest(corrupted), /version 11/);
  const stage = projects.stageProject((await projects.exportProject(room)).buffer, path.join(root, 'uploads')); try { const reopened = stage.commit(); assert.equal(reopened.lines[0].takeHistory[0].voicePresetId, 'phone'); assert.equal(chain.resolve(reopened.lines[419], reopened).pitch, -2); } finally { stage.rollback(); }
  const copied = { ...room, lines: [{ ...presets.apply(take(), room, entry(), { newId }), caption: '', claimedBy: null }] }; const old = projects.readProject((await projects.exportProject(copied)).buffer); assert.equal(old.manifest.formatVersion, 10); assert.equal(old.manifest.project.lines[0].take.voicePresetId, undefined);
});


test('only trashed role references still require explicit detach and preserve the restoration sound', () => {
  const room = scene(); room.lines = []; room.roleEffects = {}; room.deletedLines = [{ roleEffects: { Removed: { pitch: 3, effects: [], voicePresetId: 'phone', usePresetPitch: true }, Empty: undefined }, lines: [{ line: { ...take(), character: 'Removed', effects: [] } }] }];
  assert.throws(() => server.planScene(room, { nick: 'Host' }, { action: 'delete', id: 'phone', revision: 1 }, true), /preset.inUse/);
  const next = server.planScene(room, { nick: 'Host' }, { action: 'delete', id: 'phone', revision: 1, detach: true }, true), role = next.deletedLines[0].roleEffects.Removed; assert.equal(role.voicePresetId, null); assert.equal(role.pitch, -2); assert.equal(role.effects[0].type, 'telephone');
});
test('deleting a preset rebinds durable trash in Undo and freezes empty-track definitions', () => {
  const room = scene(), edits = require('./server/editHistory'); room.activeSessionId = 'undo'; const oldBatch = { roleEffects: {}, lines: [] }; room.deletedLines = [oldBatch];
  edits.record('live-unit', room, { by: 'owner', type: 'deleteTrack', batch: oldBatch }); edits.record('live-unit', room, { by: 'emptyOwner', type: 'removeTrack', character: 'Empty', roleEffects: { pitch: 0, effects: [], voicePresetId: 'phone', usePresetPitch: true } }); assert.ok(edits.usesPreset('live-unit', room, 'phone'));
  const before = { ...room }, replacement = { roleEffects: {}, lines: [] }; room.deletedLines = [replacement]; edits.detachPreset('live-unit', room, before, 'phone'); assert.equal(edits.peekFor('live-unit', room, 'owner').batch, replacement); assert.equal(edits.peekFor('live-unit', room, 'emptyOwner').roleEffects.voicePresetId, null); assert.equal(edits.peekFor('live-unit', room, 'emptyOwner').roleEffects.pitch, -2);
});


test('role preset pitch remains a dependency when role effects are explicitly bypassed', () => {
  const room = scene(); room.roleEffects.Role.voicePresetId = 'phone'; room.roleEffects.Role.usePresetPitch = true; room.lines[0].inheritRoleEffects = false; room.lines[0].pitchMode = 'inherit'; assert.ok(presets.usage(room, 'phone').lines.includes(1)); assert.equal(chain.resolve(room.lines[0], room).pitch, -2);
  room.lines[0].pitchMode = 'override'; assert.equal(presets.usage(room, 'phone').lines.includes(1), false);
});
