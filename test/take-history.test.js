const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-history-unit-'));
for (const area of ['data', 'uploads', 'packs']) { const dir = path.join(root, area); fs.mkdirSync(dir); process.env['DUBLINE_' + (area === 'uploads' ? 'UPLOAD' : area.toUpperCase()) + '_DIR'] = dir; }
after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'dubline-history-unit-'))); fs.rmSync(root, { recursive: true, force: true }); });
const history = require('../src/server/takeHistory'), files = require('../src/server/files'), { rooms } = require('../src/server/state');
const { captureProject, exportProject, stageProject, validateManifest } = require('../src/server/projects');
const { emptyTake } = require('../src/server/parsers');
const uploadDir = path.join(root, 'uploads');
function variant(id, pinned = false) { fs.writeFileSync(path.join(uploadDir, `line_${id}.webm`), Buffer.from('take ' + id)); return { ...history.DEFAULTS, id, audioUrl: `/uploads/line_${id}.webm`, recordedBy: 'Actor', pinned, createdAt: 100, duration: 2, archivedAt: 200, effect: 'telephone', pitch: 2, audioStart: -1, recordedStart: -2, trimStart: 0.1, trimEnd: 1.9, volume: 0.6, pan: -0.2, effectAmount: 0.4 }; }
function line() { const current = variant('main'); const line = { id: 1, character: 'Role', caption: 'Text', start: 1, end: 3, claimedBy: 'Actor', ...emptyTake(), takeHistory: [], takeHistoryRevision: 1, takeSequence: 4, takeCounter: 6 }; history.activate(line, current); return line; }
const roomFor = line => ({ host: 'Host', hostClientId: 'host-device', characterClaims: {}, lines: [line], moderators: [] });
function request(line, action, takeId, extra = {}) { return { action, takeId, historyRevision: history.revision(line), expectedOwner: 'Actor', ...extra }; }
test('shared model retains all per-version audio properties, pin and stable identity without copying history', () => {
  const original = line(); original.takePinned = true; original.takeCreatedAt = 111; original.uploadId = 'upload';
  const take = history.extract(original), other = { takeCounter: 90, takeSequence: 80 }; history.activate(other, take);
  for (const field of history.FIELDS) assert.deepEqual(other[field], original[field]);
  assert.equal(other.takeId, original.takeId); assert.equal(other.takePinned, true); assert.equal(other.takeSequence, 80); assert.equal(other.takeCounter, 90);
  assert.equal(take.takeHistory, undefined);
});
for (const count of [0, 1, 2]) test(`replacement keeps all ${count} prior takes when a slot is free`, () => { const l = line(); l.takeHistory = Array.from({ length: count }, (_, i) => variant('free' + i)); assert.deepEqual(history.planUpload(l), { kind: 'keep', evict: null }); });
test('full history evicts the oldest unpinned take, not the oldest pinned one', () => { const l = line(); l.takeHistory = [variant('new'), variant('middle'), variant('old', true)]; assert.equal(history.planUpload(l).evict, 'middle'); l.takePinned = true; assert.equal(history.planUpload(l).evict, 'middle'); });
test('three pinned variants require explicit exact-main/revision consent and four pinned cannot be overridden', () => {
  const l = line(); l.takeHistory = [variant('a', true), variant('b', true), variant('c', true)];
  assert.throws(() => history.planUpload(l), e => e.key === 'takeHistory.confirmOverwriteRequired');
  assert.throws(() => history.planUpload(l, { discardCurrentId: 'old', historyRevision: 1 }), e => e.status === 409);
  assert.equal(history.planUpload(l, { discardCurrentId: l.takeId, historyRevision: 1 }).kind, 'confirm');
  l.takePinned = true; assert.throws(() => history.planUpload(l, { discardCurrentId: l.takeId, historyRevision: 1 }), e => e.key === 'takeHistory.full');
});
test('restore swaps slots and settings, preserves pins, closes retake and invalidates pending reservations', () => {
  const l = line(); l.takeHistory = [variant('c'), variant('b', true), variant('a')]; l.needsRetake = true; l.retakeComment = 'old note'; l.retakeRevision = 2;
  const result = history.action(roomFor(l), l, request(l, 'restore', 'b'), 'Actor', 'actor-device');
  assert.equal(result.next.takeId, 'b'); assert.equal(result.next.takePinned, true); assert.deepEqual(result.next.takeHistory.map(t => t.id), ['main', 'c', 'a']);
  for (const field of history.FIELDS) assert.deepEqual(result.next[field], l.takeHistory[1][field]);
  assert.equal(result.next.needsRetake, false); assert.equal(result.next.retakeComment, ''); assert.ok(result.next.retakeSequence > l.takeCounter || result.next.takeSequence > l.takeCounter);
  assert.equal(result.deleted.length, 0); assert.equal(l.takeId, 'main');
});
test('deleting main keeps history, does not restore automatically and restore works without main', () => {
  const l = line(); l.takeHistory = [variant('saved', true)];
  const deleted = history.action(roomFor(l), l, request(l, 'delete', l.takeId), 'Actor', 'actor-device').next;
  assert.equal(deleted.audioUrl, null); assert.equal(deleted.takeHistory.length, 1);
  const restored = history.action(roomFor(deleted), deleted, request(deleted, 'restore', 'saved'), 'Actor', 'actor-device').next;
  assert.equal(restored.takeId, 'saved'); assert.equal(restored.takePinned, true); assert.equal(restored.takeHistory.length, 0);
});
test('pin/unpin is metadata only; pinned manual deletion requires confirmation and revisions reject concurrent changes', () => {
  const l = line(); l.takeHistory = [variant('past')];
  const pinned = history.action(roomFor(l), l, request(l, 'pin', 'past', { value: true }), 'Actor', 'actor-device').next;
  assert.equal(pinned.takeHistory[0].pinned, true); assert.equal(pinned.audioUrl, l.audioUrl); assert.ok(fs.existsSync(files.takePath(l.audioUrl)));
  assert.throws(() => history.action(roomFor(pinned), pinned, request(pinned, 'delete', 'past'), 'Actor', 'actor-device'), e => e.key === 'takeHistory.confirmDeleteRequired');
  assert.throws(() => history.action(roomFor(pinned), pinned, request(l, 'pin', 'past', { value: false }), 'Actor', 'actor-device'), e => e.key === 'takeHistory.changed');
  assert.equal(history.action(roomFor(pinned), pinned, request(pinned, 'delete', 'past', { confirmPinned: true }), 'Actor', 'actor-device').next.takeHistory.length, 0);
});
test('foreign actor is denied; free-line author can only manage their own variant', () => {
  const l = line(); l.takeHistory = [variant('mine'), { ...variant('foreign'), recordedBy: 'Other' }];
  assert.throws(() => history.action(roomFor(l), l, request(l, 'delete', 'mine'), 'Other', 'other'), e => e.status === 403);
  l.claimedBy = null; const room = roomFor(l);
  const free = { ...request(l, 'pin', 'mine', { value: true }), expectedOwner: null };
  assert.equal(history.action(room, l, free, 'Actor', 'actor').next.takeHistory[0].pinned, true);
  assert.throws(() => history.action(room, l, { ...free, takeId: 'foreign' }, 'Actor', 'actor'), e => e.status === 403);
});
test('missing assets and malformed/oversized histories fail closed without mutation', () => {
  const l = line(); l.takeHistory = [variant('missing')]; fs.unlinkSync(files.takePath(l.takeHistory[0].audioUrl));
  assert.throws(() => history.action(roomFor(l), l, request(l, 'restore', 'missing'), 'Actor', 'actor'), e => e.key === 'takeHistory.missing');
  l.takeHistory = Array.from({ length: 4 }, (_, i) => variant('excess' + i)); assert.throws(() => history.planUpload(l), e => e.key === 'takeHistory.invalid'); assert.equal(l.takeHistory.length, 4);
  l.takeHistory = [history.extract(l)]; assert.throws(() => history.check(l), e => e.key === 'takeHistory.invalid');
  const corrupt = { ...l, takeHistory: { pinned: true, audioUrl: '/uploads/line_saved.webm' } }; history.normalize(corrupt);
  assert.equal(Array.isArray(corrupt.takeHistory), false); assert.throws(() => history.check(corrupt), e => e.key === 'takeHistory.invalid');
});
test('legacy trash receives stable main identity before Undo without losing its recording or settings', () => {
  const l = line(); delete l.takeId; delete l.takeHistory; delete l.takePinned;
  const scene = { lines: [], deletedLines: [{ lines: [{ line: l }] }] };
  require('../src/server/rooms').normalizeEditorState(scene);
  assert.ok(history.validId(l.takeId)); assert.deepEqual(l.takeHistory, []); assert.equal(l.takePinned, false); assert.equal(l.effect, 'telephone'); assert.ok(l.audioUrl);
});
test('unlink waits for durable references and active readers, protects shared/trash references and rejects unsafe paths', () => {
  const take = variant('cleanup'); rooms.test = { lines: [{ audioUrl: take.audioUrl }] }; files.notePersistedReferences(rooms);
  assert.equal(files.deleteTakeFile(take.audioUrl).kept, true);
  const release = files.retainTakeFiles([take.audioUrl]); delete rooms.test;
  assert.equal(files.deleteTakeFile(take.audioUrl).deferred, true); files.notePersistedReferences(rooms);
  assert.equal(fs.existsSync(files.takePath(take.audioUrl)), true); release(); release(); assert.equal(fs.existsSync(files.takePath(take.audioUrl)), false);
  const saved = variant('trash'); rooms.test = { deletedLines: [{ lines: [{ line: { takeHistory: [saved] } }] }] }; files.notePersistedReferences(rooms);
  assert.equal(files.deleteTakeFile(saved.audioUrl).kept, true); delete rooms.test;
  for (const url of ['/uploads/../outside.webm', '/uploads/custom_project_x/file.webm', '/packs/line_x.webm', '/uploads/line_x.webm/../keep', '/uploads/line_x.webm?token=secret']) assert.equal(files.takePath(url), null);
});
test('strict room write failure rolls back line metadata and keeps main/pinned files', () => {
  const l = line(), room = roomFor(l), before = structuredClone(l), module = require('../src/server/rooms'), flush = module.flushRooms;
  module.flushRooms = () => { const error = new Error('disk'); error.code = 'ENOSPC'; throw error; };
  try { assert.throws(() => history.commit(room, room, l, { ...l, audioUrl: null }), e => e.status === 507); assert.deepEqual(l, before); assert.ok(fs.existsSync(files.takePath(l.audioUrl))); }
  finally { module.flushRooms = flush; }
});
test('actual atomic rename failure preserves rooms.json and restores main metadata without deleting files', () => {
  const module = require('../src/server/rooms'), l = line(), room = roomFor(l), rename = fs.renameSync;
  rooms.disk = room; module.flushRooms({ strict: true }); const file = require('../src/server/config').ROOMS_FILE, bytes = fs.readFileSync(file), before = structuredClone(l);
  fs.renameSync = (source, target) => { if (target === file) { const error = new Error('disk full'); error.code = 'ENOSPC'; throw error; } return rename(source, target); };
  try { assert.throws(() => history.commit(room, room, l, { ...l, takePinned: true }), e => e.status === 507); assert.deepEqual(l, before); assert.deepEqual(fs.readFileSync(file), bytes); assert.ok(fs.existsSync(files.takePath(l.audioUrl))); }
  finally { fs.renameSync = rename; delete rooms.disk; }
});
test('unlink error retains the file and reports failure without modifying committed metadata', () => {
  const take = variant('disk-delete-error'), unlink = fs.unlinkSync; files.notePersistedReferences(rooms); let reported = false;
  fs.unlinkSync = file => { if (file === files.takePath(take.audioUrl)) { const error = new Error('locked'); error.code = 'EPERM'; throw error; } return unlink(file); };
  try { assert.equal(files.deleteTakeFile(take.audioUrl, { onError: () => { reported = true; } }).error, 'EPERM'); assert.equal(reported, true); assert.ok(fs.existsSync(files.takePath(take.audioUrl))); }
  finally { fs.unlinkSync = unlink; }
});
test('orphan collector recognizes generated imported takes with all legacy audio extensions and keeps historical refs', () => {
  const gc = require('../src/server/orphanGc');
  for (const extension of ['webm', 'wav', 'mp4', 'm4a', 'opus']) assert.equal(gc.recognized('uploads', { name: `line_project_${'a'.repeat(32)}_3.${extension}`, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }), true);
  const take = variant('gc-history'); assert.ok(gc.references({ scene: { lines: [{ takeHistory: [take] }] } }, uploadDir, path.join(root, 'packs')).has(process.platform === 'win32' ? files.takePath(take.audioUrl).toLowerCase() : files.takePath(take.audioUrl)));
});
function project() { const l = line(); l.takePinned = true; l.takeHistory = [variant('projectC', true), variant('projectB'), variant('projectA', true)]; fs.writeFileSync(path.join(uploadDir, 'video.mp4'), 'video'); return { loaded: true, title: 'History', kind: 'custom', mode: 'dub', trackOrder: ['Role'], characterClaims: {}, videoUrl: '/uploads/video.mp4', lines: [l], latency: { Actor: 42 } }; }
test('format 6 round trip keeps all four assets, stable IDs, pins and settings, excludes runtime credentials/counters', async () => {
  const p = project(), snapshot = captureProject(p); assert.equal(snapshot.manifest.formatVersion, 6); assert.equal(snapshot.manifest.assets.length, 5);
  const text = JSON.stringify(snapshot.manifest); for (const key of ['takeSequence', 'takeCounter', 'uploadId', 'takeHistoryRevision', 'clientId']) assert.equal(text.includes(key), false);
  const bytes = (await exportProject(p)).buffer, staged = stageProject(bytes, uploadDir);
  try { const l = staged.fields.lines[0]; assert.equal(l.takeId, p.lines[0].takeId); assert.equal(l.takePinned, true); assert.deepEqual(l.takeHistory.map(t => [t.id, t.pinned]), p.lines[0].takeHistory.map(t => [t.id, t.pinned]));
    for (let i = 0; i < 3; i++) for (const field of history.FIELDS.filter(field => field !== 'audioUrl')) assert.deepEqual(l.takeHistory[i][field], p.lines[0].takeHistory[i][field]);
    staged.commit(); for (const take of [history.extract(l), ...l.takeHistory]) assert.ok(fs.existsSync(files.takePath(take.audioUrl)));
  } finally { staged.rollback(); }
});
test('format 6 history without main audio reopens unrecorded and can restore a previous variant', async () => {
  const p = project(); p.lines[0].audioUrl = null; p.lines[0].takeId = null; p.lines[0].takePinned = false;
  const staged = stageProject((await exportProject(p)).buffer, uploadDir);
  try { staged.commit(); const l = staged.fields.lines[0]; assert.equal(l.audioUrl, null); assert.equal(l.takeHistory.length, 3); assert.equal(history.action(roomFor(l), l, request(l, 'restore', l.takeHistory[0].id), 'Actor', 'actor').next.takeHistory.length, 2); }
  finally { staged.rollback(); }
});
test('disk snapshot contains immutable bytes for main and all historical assets before async archive work', () => {
  const p = project(), snapshotDir = fs.mkdtempSync(path.join(root, 'snapshot-')), snapshot = captureProject(p, undefined, snapshotDir);
  for (const take of [history.extract(p.lines[0]), ...p.lines[0].takeHistory]) fs.writeFileSync(files.takePath(take.audioUrl), 'changed');
  for (const [name, file] of snapshot.files) if (name.startsWith('recordings/')) assert.notEqual(fs.readFileSync(file, 'utf8'), 'changed');
});
for (const [label, mutate] of [
  ['too many takes', m => m.project.lines[0].takeHistory.push(structuredClone(m.project.lines[0].takeHistory[0]))],
  ['duplicate ID', m => m.project.lines[0].takeHistory[0].id = m.project.lines[0].take.id],
  ['duplicate asset', m => m.project.lines[0].takeHistory[0].asset = m.project.lines[0].take.asset],
  ['missing asset', m => m.project.lines[0].takeHistory[0].asset = 'recordings/missing.webm'],
  ['external URL', m => m.project.lines[0].takeHistory[0].asset = 'https://example.com/voice.webm'],
  ['invalid pin', m => m.project.lines[0].takeHistory[0].pinned = 'true'],
  ['invalid timing', m => m.project.lines[0].takeHistory[0].trimEnd = -1],
  ['invalid effect', m => m.project.lines[0].takeHistory[0].effect = 'unknown'],
  ['invalid gain', m => m.project.lines[0].takeHistory[0].volume = 10],
  ['downgrade', m => m.formatVersion = 5]
]) test('format 6 rejects ' + label + ' before extraction', () => { const snapshot = captureProject(project()); mutate(snapshot.manifest); assert.throws(() => validateManifest(snapshot.manifest), e => e.status === 400); });
