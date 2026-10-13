const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-chain-unit-'));
for (const area of ['data', 'uploads', 'packs']) { const directory = path.join(root, area); fs.mkdirSync(directory); process.env['DUBLINE_' + (area === 'uploads' ? 'UPLOAD' : area.toUpperCase()) + '_DIR'] = directory; }
after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'dubline-chain-unit-'))); fs.rmSync(root, { recursive: true, force: true }); });
const model = require('./public/voice-chain-model'), server = require('./server/voiceChains');
const history = require('./public/take-history-model'), projects = require('./server/projects');
const fx = (type, amount = 1, id = type) => ({ id, type, amount, enabled: true, parameters: {} });
const take = () => ({ id: 1, character: 'A', caption: 'Line', start: 1, end: 2, audioUrl: '/uploads/line_one.wav', recordedBy: 'Actor', takeId: 'one', takeMixRevision: 3, pitch: -2, effect: 'monster', effectAmount: .5, trimStart: .1, trimEnd: .9, trimEnabled: true, volume: .6, pan: .2, takePinned: true });
const scene = () => ({ loaded: true, title: 'Chain', kind: 'custom', mode: 'dub', trackOrder: ['A', 'B'], lines: [take()], characterClaims: {}, roleEffects: { A: { pitch: -3, effects: [fx('robot', .7)], revision: 2 } }, videoUrl: '/uploads/scene.mp4', videoHasAudio: false });
const target = line => ({ lineId: line.id, character: line.character, takeId: line.takeId, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision });
test('legacy single-effect adapter preserves amount and explicit pitch; new takes inherit without summing', () => {
  const s = scene(), line = take(), legacy = model.take(line);
  assert.equal(legacy.pitchMode, 'override'); assert.deepEqual(legacy.effects, [fx('monster', .5, 'legacy')]);
  const config = model.resolve(line, s); assert.equal(config.pitch, -2); assert.deepEqual(config.effects.map(item => item.type), ['robot', 'monster']);
  line.pitchMode = 'inherit'; assert.equal(model.resolve(line, s).pitch, -3);
  line.inheritRoleEffects = false; assert.deepEqual(model.resolve(line, s).effects.map(item => item.type), ['monster']);
});
test('ordered duplicate instances, disabled/zero stages and individual role exceptions retain identity', () => {
  const s = scene(), line = { ...take(), effects: [fx('echo', .4, 'e1'), fx('echo', .2, 'e2')], excludedRoleEffectIds: ['robot'] };
  assert.deepEqual(model.resolve(line, s).effects.map(item => item.id), ['e1', 'e2']);
  line.effects[0].enabled = false; line.effects[1].amount = 0; assert.equal(model.active(model.resolve(line, s).effects).length, 0);
  const archived = history.extract(line); history.activate(line, archived); line.effects[0].amount = .9; assert.equal(archived.effects[0].amount, .4);
});
test('strict model rejects duplicate IDs, unknown/oversized parameters, invalid feedback and combined resource limits', () => {
  assert.equal(model.validEffects([fx('robot'), fx('robot')]), false);
  for (const effects of [[fx('unknown')], [fx('robot', NaN)], [{ ...fx('echo'), parameters: { feedback: 1 } }], [{ ...fx('radio'), parameters: { bad: 1 } }], Array.from({ length: 9 }, (_, i) => fx('robot', 1, 'r' + i))]) assert.equal(model.validEffects(effects), false);
  assert.equal(model.safe({ pitch: 0, effects: Array.from({ length: 5 }, (_, i) => fx('monster', 1, 'm' + i)) }), false);
  assert.equal(model.safe({ pitch: 0, effects: Array.from({ length: 8 }, (_, i) => ({ ...fx('echo', 1, 'e' + i), parameters: { delay: .8, feedback: .7 } })) }), false);
  assert.equal(model.tail({ ...fx('echo'), enabled: false }), 0);
});
test('server atomically authorizes batches, checks immutable take identity and preserves unrelated take fields', () => {
  const room = scene(), settings = { ...model.take(room.lines[0]), effects: [fx('telephone'), fx('echo')], pitchMode: 'inherit' };
  const request = { scope: 'takes', action: 'replace', takes: [target(room.lines[0])], settings };
  assert.throws(() => server.plan(room, { nick: 'Other' }, request, false, () => 'Other'), /fx.owner/);
  assert.throws(() => server.plan(room, { nick: 'Actor' }, { ...request, takes: [{ ...request.takes[0], takeId: 'old' }] }, false, () => 'Actor'), /fx.conflict/);
  const result = server.plan(room, { nick: 'Actor' }, request, false, () => 'Actor');
  assert.equal(result.lines[0].takePinned, true); assert.equal(result.lines[0].pan, .2); assert.equal(result.lines[0].trimStart, .1); assert.equal(result.lines[0].takeMixRevision, 4);
  assert.equal(room.lines[0].effect, 'monster'); assert.equal(model.resolve(result.lines[0], { ...room, roleEffects: result.roles }).pitch, -3);
});
test('role updates require moderator and revision; limits include historic takes and future role chain', () => {
  const room = scene(), request = { scope: 'role', character: 'A', revision: 2, settings: { pitch: -1, effects: [fx('radio')] } };
  assert.throws(() => server.plan(room, { nick: 'Actor' }, request, false, () => 'Actor'), /fx.owner/);
  assert.throws(() => server.plan(room, { nick: 'Host' }, { ...request, revision: 1 }, true, () => 'Actor'), /fx.conflict/);
  room.lines[0].takeHistory = [{ ...history.extract(room.lines[0]), id: 'old', effects: Array.from({ length: 8 }, (_, i) => fx('robot', 1, 'r' + i)) }];
  assert.throws(() => server.plan(room, { nick: 'Host' }, request, true, () => 'Actor'), /fx.limit/);
});
test('bulk chain operations preserve different pitch overrides unless pitch editing is explicitly requested', () => {
  const room = scene(); room.lines.push({ ...take(), id: 2, takeId: 'two', character: 'B', pitch: 4, pitchMode: 'inherit' });
  const request = { scope: 'takes', action: 'append', takes: room.lines.map(target), pitch: 7, settings: { ...model.take(take()), effects: [fx('echo')] } };
  const appended = server.plan(room, { nick: 'Host' }, request, true, () => 'Actor'); assert.deepEqual(appended.lines.map(line => line.pitch), [-2, 4]); assert.equal(appended.lines[1].pitchMode, 'inherit');
  const replaced = server.plan(room, { nick: 'Host' }, { ...request, action: 'replace' }, true, () => 'Actor'); assert.deepEqual(replaced.lines.map(line => line.pitch), [-2, 4]); assert.equal(replaced.lines[1].pitchMode, 'inherit');
  const explicit = server.plan(room, { nick: 'Host' }, { ...request, action: 'replace', editPitch: true }, true, () => 'Actor'); assert.deepEqual(explicit.lines.map(line => line.pitch), [7, 7]); assert.equal(explicit.lines[1].pitchMode, 'override');
});
test('voice settings cannot smuggle file paths, authors, ownership, history or mix into an authorized mutation', () => {
  const room = scene(), before = structuredClone(room), settings = model.take(room.lines[0]);
  for (const patch of [{ audioUrl: '/uploads/source_video_private.mp4' }, { recordedBy: 'Host' }, { claimedBy: 'Host' }, { character: 'B' }, { takeId: 'forged' }, { takeHistory: [] }, { volume: 100 }, { effectAmount: 0 }, { needsRetake: false }]) {
    assert.throws(() => server.plan(room, { nick: 'Actor' }, { scope: 'takes', action: 'replace', takes: [target(room.lines[0])], settings: { ...settings, ...patch } }, false, () => 'Actor'), /fx.invalid/);
    assert.deepEqual(room, before);
  }
});
test('prototype-like role names remain ordinary data through shared definitions and rename', () => {
  const room = scene(); room.trackOrder.push('__proto__'); room.roleEffects = Object.assign(Object.create(null), room.roleEffects);
  const result = server.plan(room, { nick: 'Host' }, { scope: 'role', character: '__proto__', revision: 0, settings: { pitch: 0, effects: [fx('echo')] } }, true, () => 'Actor');
  assert.ok(Object.hasOwn(result.roles, '__proto__')); assert.equal(Object.getPrototypeOf(result.roles), null);
  room.roleEffects = result.roles; server.rename(room, '__proto__', 'constructor'); assert.ok(Object.hasOwn(room.roleEffects, 'constructor')); assert.equal(model.role(room, 'constructor').effects[0].type, 'echo');
});
test('resolved configuration cache key tracks order/amount/pitch but ignores inert stage identities', () => {
  const a = { pitch: 0, effects: [fx('robot'), fx('echo')] }, b = { ...a, effects: [...a.effects].reverse() };
  assert.notEqual(model.key(a), model.key(b)); assert.notEqual(model.key(a), model.key({ ...a, pitch: 1 }));
  assert.equal(model.key(a), model.key({ ...a, effects: [...a.effects, { ...fx('cave'), enabled: false }] }));
  const line = { ...take(), _exportVoice: model.resolve(take(), scene()) }, frozen = model.resolve(line, scene());
  const changed = scene(); changed.roleEffects.A.effects = []; assert.deepEqual(model.resolve(line, changed), frozen);
});
test('portable version 8 retains role/individual/history settings and rejects malformed chains before extraction', async () => {
  const room = scene(); for (const name of ['scene.mp4', 'line_one.wav']) fs.writeFileSync(path.join(root, 'uploads', name), Buffer.from('fixture ' + name));
  Object.assign(room.lines[0], { effects: [fx('echo', .4)], pitchMode: 'inherit', inheritRoleEffects: true, excludedRoleEffectIds: [] });
  const archive = await projects.exportProject(room), read = projects.readProject(archive.buffer);
  assert.equal(read.manifest.formatVersion, 8); assert.deepEqual(read.manifest.project.roleEffects.A.effects, room.roleEffects.A.effects);
  const staged = projects.stageProject(archive.buffer, path.join(root, 'uploads')); try { const fields = staged.commit(); assert.deepEqual(fields.lines[0].effects, room.lines[0].effects); assert.equal(fields.lines[0].pitchMode, 'inherit'); } finally { staged.rollback(); }
  const bad = structuredClone(read.manifest); bad.project.lines[0].take.effects[0].parameters.feedback = 2; assert.throws(() => projects.validateManifest(bad), /Invalid voice chain/);
  const older = structuredClone(read.manifest); older.formatVersion = 7; assert.throws(() => projects.validateManifest(older));
});
