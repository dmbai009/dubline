const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-single-chain-'));
for (const folder of ['data', 'uploads', 'packs']) { fs.mkdirSync(path.join(root, folder)); process.env['DUBLINE_' + (folder === 'uploads' ? 'UPLOAD' : folder.toUpperCase()) + '_DIR'] = path.join(root, folder); }
after(() => fs.rmSync(root, { recursive: true, force: true }));
const chain = require('../src/public/voice-chain-model'), presets = require('../src/public/voice-preset-model');
const voices = require('../src/server/voiceChains'), catalog = require('../src/server/voicePresets'), projects = require('../src/server/projects'), history = require('../src/public/take-history-model');
const effect = (id, type = 'radio', enabled = true) => ({ id, type, enabled, amount: .5, parameters: {} });
function scene() {
  return { loaded: true, kind: 'custom', mode: 'dub', title: 'Single chain', videoUrl: '/uploads/video.mp4', videoHasAudio: false, trackOrder: ['Hero'], characterClaims: {}, roleEffects: {}, voicePresets: {
    radio: { id: 'radio', name: 'Radio', createdBy: 'Author', revision: 1, effects: [effect('radio')], pitch: 4 },
    robot: { id: 'robot', name: 'Robot', createdBy: 'Author', revision: 1, effects: [effect('robot', 'robot')] }
  }, lines: [{ id: 1, character: 'Hero', caption: '', start: 0, end: 1, audioUrl: '/uploads/take.wav', takeId: 'current', recordedBy: 'Author', pitch: 0, pitchMode: 'inherit', effects: [], inheritRoleEffects: true, excludedRoleEffectIds: [], takeHistory: [] }] };
}
const types = (line, room) => chain.resolve(line, room).effects.map(item => item.type);
test('one own chain follows the role preset; bypass does not remove the take chain', () => {
  const room = scene(), line = presets.link(room.lines[0], room, 'radio', true);
  assert.deepEqual(types(line, room), ['radio']);
  room.roleEffects.Hero = { pitch: 0, effects: [], voicePresetId: 'robot', usePresetPitch: true, presetModified: false };
  assert.deepEqual(types(room.lines[0], room), ['robot']);
  assert.deepEqual(types(line, room), ['robot', 'radio']);
  const variant = chain.modify(line, room); variant.effects[0].amount = .2;
  assert.deepEqual(types(variant, room), ['robot', 'radio']);
  assert.deepEqual(types({ ...variant, inheritRoleEffects: false }, room), ['radio']);
  assert.equal(chain.resolve(variant, room).pitch, 4);
  assert.deepEqual(line.effects, []); assert.equal(room.voicePresets.radio.effects[0].amount, .5);
  let n = 0; const copied = presets.apply(line, room, room.voicePresets.robot, { newId: () => 'copy-' + ++n });
  assert.equal(copied.voicePresetId, null); assert.equal(copied.presetModified, true); assert.deepEqual(types(copied, room), ['robot', 'robot']);
});
test('private variants freeze the complete own chain and pitch while references stay live', () => {
  const room = scene(), linked = presets.link(room.lines[0], room, 'radio', true), variant = chain.modify(linked, room);
  variant.effects.push(effect('echo', 'echo')); room.lines = [linked, { ...variant, id: 2, takeId: 'private' }];
  room.lines[0].takeHistory = [{ ...history.extract({ ...linked, takeId: 'archived' }), archivedAt: 1 }];
  const next = catalog.planScene(room, { nick: 'Author' }, { action: 'update', id: 'radio', revision: 1, settings: { effects: [effect('new', 'telephone')], pitch: -3 } }, false);
  assert.deepEqual(types(next.lines[0], next), ['telephone']); assert.equal(chain.resolve(next.lines[0].takeHistory[0], next).pitch, -3);
  assert.deepEqual(types(next.lines[1], next), ['radio', 'echo']); assert.equal(chain.resolve(next.lines[1], next).pitch, 4);
  assert.deepEqual(presets.usage(next, 'radio').lines, [1]); assert.equal(next.lines[1].voicePresetId, 'radio');
});
test('lazy legacy conversion preserves combined order, disabled stages, pitch, mix and history', () => {
  const room = scene(); room.roleEffects.Hero = { pitch: -2, effects: [effect('role', 'robot')] };
  const old = { ...room.lines[0], voicePresetId: 'radio', usePresetPitch: true, effects: [effect('extra', 'echo'), effect('off', 'telephone', false)], volume: .7, pan: -.3, trimStart: .1 };
  const before = structuredClone(old), upgraded = chain.editable(old, room);
  assert.equal(chain.key(chain.resolve(upgraded, room)), chain.key(chain.resolve(old, room)));
  assert.equal(upgraded.presetModified, true); assert.deepEqual(upgraded.effects.map(item => item.id), ['radio', 'extra', 'off']);
  assert.equal(upgraded.volume, .7); assert.equal(upgraded.pan, -.3); assert.equal(upgraded.trimStart, .1); assert.deepEqual(old, before);
  const archived = history.extract({ ...upgraded, takeId: 'archived' }), restored = { audioUrl: null };
  history.activate(restored, archived); assert.equal(restored.presetModified, true); assert.deepEqual(restored.effects, upgraded.effects);
  assert.equal(chain.modify({ ...old, presetModified: null }, room).presetModified, true);
});
test('snapshots preserve sixteen legacy stages without allowing more active work or hidden overlays', () => {
  const room = scene(); room.voicePresets.radio.effects = Array.from({ length: 8 }, (_, i) => effect('preset' + i, 'radio', false));
  const old = { ...room.lines[0], voicePresetId: 'radio', effects: Array.from({ length: 8 }, (_, i) => effect('own' + i, 'telephone', i < 2)) };
  const next = chain.editable(old, room); assert.equal(next.effects.length, 16); assert.ok(chain.validTake(chain.take(next))); assert.ok(chain.safe(chain.resolve(next, room)));
  assert.equal(chain.key(chain.resolve(old, room)), chain.key(chain.resolve(next, room)));
  assert.equal(chain.validTake({ ...chain.take(next), presetModified: false }), false);
  assert.equal(presets.validSettings({ effects: Array.from({ length: 9 }, (_, i) => effect('e' + i)) }), false);
});
test('server checks take ownership, exact identity, source revision and atomic batch limits', () => {
  const room = scene(); room.lines[0] = presets.link(room.lines[0], room, 'radio', true);
  const line = room.lines[0], settings = chain.take(chain.modify(line, room)); settings.effects[0].amount = .2;
  const request = { scope: 'takes', action: 'replace', settings, pitch: 4, presetRevision: 1, takes: [{ lineId: 1, character: 'Hero', audioUrl: line.audioUrl, takeId: 'current', takeMixRevision: 0, presetRevision: 1 }] };
  assert.throws(() => voices.plan(room, { nick: 'Other' }, request, false, () => 'Other'), /fx.owner/);
  const plan = voices.plan(room, { nick: 'Author' }, request, false, () => 'Author'); assert.equal(plan.lines[0].presetModified, true); assert.equal(room.lines[0].presetModified, false);
  room.voicePresets.radio.revision++;
  assert.throws(() => voices.plan(room, { nick: 'Author' }, request, false, () => 'Author'), /fx.conflict/);
  assert.throws(() => catalog.planScene(room, { nick: 'Other' }, { action: 'update', id: 'radio', revision: 2, settings: { effects: [] } }, false), /preset.owner/);
});
test('delete freezes modified references, live references and role snapshots without doubling a chain', () => {
  const room = scene(); const line = chain.modify(presets.link(room.lines[0], room, 'radio', true), room); line.effects.push(effect('extra', 'echo')); room.lines = [line];
  room.roleEffects.Hero = { pitch: 0, effects: [], voicePresetId: 'robot', presetModified: false };
  const before = chain.key(chain.resolve(line, room));
  const next = catalog.planScene(room, { nick: 'Author' }, { action: 'delete', id: 'radio', revision: 1, detach: true }, false);
  assert.equal(next.lines[0].voicePresetId, null); assert.equal(chain.key(chain.resolve(next.lines[0], next)), before);
  assert.equal(next.lines[0].audioUrl, line.audioUrl);
});
test('format 13 saves private origins, snapshots and history; older formats reject the marker', async () => {
  const room = scene(); fs.writeFileSync(path.join(root, 'uploads/video.mp4'), 'video'); fs.writeFileSync(path.join(root, 'uploads/take.wav'), 'take');
  room.lines[0] = chain.modify(presets.link(room.lines[0], room, 'radio', true), room); room.lines[0].effects[0].amount = .23;
  const archived = projects.readProject((await projects.exportProject(room)).buffer); assert.equal(archived.manifest.formatVersion, 13);
  const invalid = structuredClone(archived.manifest); invalid.formatVersion = 12; assert.throws(() => projects.validateManifest(invalid), /version 13/);
  const staged = projects.stageProject((await projects.exportProject(room)).buffer, path.join(root, 'uploads'));
  try { const reopened = staged.commit(); assert.equal(reopened.lines[0].presetModified, true); assert.equal(reopened.lines[0].voicePresetId, 'radio'); assert.equal(chain.key(chain.resolve(reopened.lines[0], reopened)), chain.key(chain.resolve(room.lines[0], room))); } finally { staged.rollback(); }
  assert.equal(voices.minimumVersion(room), 3);
});
test('legacy project and persisted-scene migration freezes overlays, including trash and duplicate role IDs', async () => {
  const room = scene(); fs.writeFileSync(path.join(root, 'uploads/video.mp4'), 'video'); fs.writeFileSync(path.join(root, 'uploads/take.wav'), 'take');
  room.roleEffects.Hero = { pitch: 0, voicePresetId: 'radio', usePresetPitch: true, effects: [effect('radio', 'robot')] };
  room.lines[0] = { ...room.lines[0], voicePresetId: 'robot', effects: [effect('extra', 'echo')], excludedRoleEffectIds: ['radio'], volume: .4, pan: .2, effectAmount: .6 };
  room.deletedLines = [{ roleEffects: { Hero: structuredClone(room.roleEffects.Hero) }, lines: [{ line: structuredClone(room.lines[0]) }] }];
  const sound = chain.key(chain.resolve(room.lines[0], room)), snapshot = structuredClone(room);
  assert.equal(chain.migrateScene(snapshot), true); assert.equal(chain.migrateScene(snapshot), false);
  assert.equal(snapshot.roleEffects.Hero.presetModified, true); assert.equal(snapshot.lines[0].presetModified, true);
  assert.equal(chain.key(chain.resolve(snapshot.lines[0], snapshot)), sound);
  assert.equal(chain.key(chain.resolve(snapshot.deletedLines[0].lines[0].line, { ...snapshot, roleEffects: snapshot.deletedLines[0].roleEffects })), sound);
  voices.validateScene(snapshot); snapshot.voicePresets.radio.effects[0].amount = .1; snapshot.voicePresets.robot.effects[0].amount = .1;
  assert.equal(chain.key(chain.resolve(snapshot.lines[0], snapshot)), sound);
  const zip = (await projects.exportProject(room)).buffer, read = projects.readProject(zip); assert.equal(read.manifest.formatVersion, 11);
  const stage = projects.stageProject(zip, path.join(root, 'uploads'));
  try { const fields = stage.commit(); assert.equal(fields.lines[0].presetModified, true); assert.equal(chain.key(chain.resolve(fields.lines[0], fields)), sound); assert.equal(fields.lines[0].volume, .4); assert.equal(fields.lines[0].effectAmount, .6); } finally { stage.rollback(); }
});
test('a valid large legacy scene remains saveable after complete snapshots expand its metadata', async t => {
  const room = scene();
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(root, 'uploads', 'variant' + i + '.wav'), 'recording');
  fs.writeFileSync(path.join(root, 'uploads/video.mp4'), 'video');
  room.voicePresets.radio.effects = Array.from({ length: 8 }, (_, i) => effect('preset-' + String(i).padStart(30, '0'), 'radio', false));
  const extras = Array.from({ length: 8 }, (_, i) => effect('private-' + String(i).padStart(30, '0'), 'radio', false));
  const base = room.lines[0]; room.lines = Array.from({ length: 600 }, (_, i) => {
    const line = { ...structuredClone(base), id: i + 1, takeId: 'take-' + i, audioUrl: '/uploads/variant0.wav', voicePresetId: 'radio', effects: structuredClone(extras) };
    line.takeHistory = [1, 2, 3].map(j => ({ ...history.extract(line), id: 'old-' + i + '-' + j, audioUrl: '/uploads/variant' + j + '.wav', archivedAt: 1 })); return line;
  });
  const original = projects.captureProject(room); assert.ok(original.manifestBytes.length <= 4 * 1024 * 1024);
  chain.migrateScene(room); const migrated = projects.captureProject(room);
  assert.ok(migrated.manifestBytes.length > 4 * 1024 * 1024); assert.ok(migrated.manifestBytes.length <= projects.MAX_MANIFEST_BYTES);
  projects.validateManifest(migrated.manifest); assert.equal(migrated.manifest.formatVersion, 13);
  const disk = require('../src/server/project-archive'); const saved = await disk.exportProjectDisk(room, undefined, { folder: path.join(root, 'data') }); let staged;
  try {
    staged = await disk.stageProjectDisk(saved.path, path.join(root, 'uploads')); const reopened = staged.commit();
    assert.equal(reopened.lines.length, 600); assert.equal(reopened.lines[599].takeHistory.length, 3);
    assert.equal(reopened.lines[599].presetModified, true); assert.equal(reopened.lines[599].effects.length, 16);
    assert.equal(reopened.lines[599].takeHistory[2].effects.length, 16); voices.validateScene(reopened);
  } finally { staged?.rollback(); await saved.cleanup(); }
  t.diagnostic(`Legacy metadata ${original.manifestBytes.length} bytes; migrated metadata ${migrated.manifestBytes.length} bytes; production disk save/open verified.`);
});
