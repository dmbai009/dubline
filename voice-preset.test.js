const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-preset-unit-'));
for (const area of ['data', 'uploads', 'packs']) { const directory = path.join(root, area); fs.mkdirSync(directory); process.env['DUBLINE_' + (area === 'uploads' ? 'UPLOAD' : area.toUpperCase()) + '_DIR'] = directory; }
after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'dubline-preset-unit-'))); fs.rmSync(root, { recursive: true, force: true }); });
const model = require('./public/voice-preset-model'), chain = require('./public/voice-chain-model'), server = require('./server/voicePresets'), projects = require('./server/projects');
const effect = (id, type = 'echo') => ({ id, type, enabled: true, amount: .65, parameters: type === 'echo' ? { delay: .13, feedback: .25 } : {} });
const preset = () => ({ id: 'p1', name: 'Old radio', createdBy: 'Actor', revision: 1, effects: [effect('a', 'radio'), effect('b')], pitch: -2 });
test('catalogue authorizes creators and moderators, protects revisions and cannot mutate takes', () => {
  const room = { voicePresets: { p1: preset() }, lines: [{ id: 1, recordedBy: 'Other' }] }, before = structuredClone(room);
  const data = { action: 'rename', id: 'p1', revision: 1, name: 'Renamed' };
  assert.throws(() => server.plan(room, { nick: 'Other' }, data, false), /preset.owner/);
  assert.throws(() => server.plan(room, { nick: 'Actor' }, { ...data, revision: 0 }, false), /preset.conflict/);
  assert.equal(server.plan(room, { nick: 'Actor' }, data, false).p1.revision, 2);
  assert.equal(server.plan(room, { nick: 'Moderator' }, data, true).p1.name, 'Renamed');
  assert.deepEqual(room, before);
  const created = server.plan(room, { nick: 'Other' }, { action: 'create', id: 'p2', revision: 0, name: 'New', settings: { effects: [] } }, false);
  assert.equal(created.p2.createdBy, 'Other'); assert.equal(Object.getPrototypeOf(created), null);
});
test('strict preset limits reject smuggled media/noise fields, invalid pitch/parameters and capacity', () => {
  for (const patch of [{ volume: 3 }, { pan: 1 }, { audioUrl: '/uploads/x.wav' }, { noiseReduction: {} }, { pitch: NaN }, { pitch: 13 }, { effects: [effect('a'), effect('a')] }]) assert.equal(model.validSettings({ effects: [], ...patch }), false);
  for (const value of ['', ' ', 'x'.repeat(81), 'bad\nname']) assert.equal(model.name(value), false);
  assert.equal(model.validLibrary({ p1: { ...preset(), settings: {} } }), false);
  const room = { voicePresets: Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['p' + i, { ...preset(), id: 'p' + i }])) };
  assert.throws(() => server.plan(room, { nick: 'Actor' }, { action: 'create', id: 'extra', revision: 0, name: 'Extra', settings: { effects: [] } }, false), /preset.capacity/);
});
test('application copies independent IDs/order/parameters, preserves inheritance and optional pitch, survives preset deletion', () => {
  let sequence = 0; const newId = () => 'copy' + ++sequence, source = preset(), take = { character: 'Role', effects: [effect('own', 'telephone')], pitch: 4, pitchMode: 'inherit', inheritRoleEffects: true, excludedRoleEffectIds: [] };
  const scene = { roleEffects: { Role: { pitch: 7, effects: [effect('role', 'robot')] } } };
  const replaced = model.apply(take, scene, source, { newId }); assert.equal(replaced.pitch, 4); assert.equal(replaced.pitchMode, 'inherit'); assert.equal(replaced.inheritRoleEffects, true);
  assert.deepEqual(chain.resolve(replaced, scene).effects.map(item => item.type), ['robot', 'radio', 'echo']); assert.equal(chain.resolve(replaced, scene).pitch, 7);
  const appended = model.apply(take, scene, source, { append: true, pitch: true, newId }); assert.deepEqual(appended.effects.map(item => item.type), ['telephone', 'radio', 'echo']); assert.equal(appended.pitch, -2); assert.equal(appended.pitchMode, 'override');
  const second = model.apply(take, scene, source, { newId }); assert.notEqual(second.effects[0].id, replaced.effects[0].id);
  source.effects[1].parameters.delay = .5; source.effects = []; assert.equal(replaced.effects[1].parameters.delay, .13); assert.equal(second.effects.length, 2);
});
test('combined inherited complexity is rejected without truncating the original chain', () => {
  const scene = { roleEffects: { Role: { pitch: 0, effects: Array.from({ length: 7 }, (_, i) => effect('role' + i, 'robot')) } } };
  const take = { character: 'Role', effects: [], inheritRoleEffects: true }, before = structuredClone(take);
  assert.throws(() => model.apply(take, scene, preset(), { newId: (() => { let i = 0; return () => 'new' + i++; })() }), /fx.limit/); assert.deepEqual(take, before);
});
test('format 10 round trips only this scene catalogue; legacy 1–9 reject smuggled catalogues and import empty', async () => {
  fs.writeFileSync(path.join(root, 'uploads', 'scene.mp4'), Buffer.from('synthetic video fixture'));
  const room = { loaded: true, title: 'Presets', kind: 'custom', mode: 'dub', trackOrder: ['Role'], lines: [], characterClaims: {}, roleEffects: {}, voicePresets: { p1: preset() }, videoUrl: '/uploads/scene.mp4', videoHasAudio: false };
  const archive = await projects.exportProject(room), read = projects.readProject(archive.buffer); assert.equal(read.manifest.formatVersion, 10); assert.deepEqual(read.manifest.project.voicePresets.p1, preset());
  const staged = projects.stageProject(archive.buffer, path.join(root, 'uploads')); try { assert.deepEqual(staged.commit().voicePresets.p1, preset()); } finally { staged.rollback(); }
  const old = structuredClone(read.manifest); old.formatVersion = 9; assert.throws(() => projects.validateManifest(old), /voice presets/); delete old.project.voicePresets; projects.validateManifest(old);
  const empty = await projects.exportProject({ ...room, voicePresets: {} }); assert.ok(projects.readProject(empty.buffer).manifest.formatVersion < 10);
  const corrupt = structuredClone(read.manifest); corrupt.project.voicePresets.p1.audioUrl = '/uploads/private.wav'; assert.throws(() => projects.validateManifest(corrupt), /voice presets/);
});
