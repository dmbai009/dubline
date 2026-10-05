const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { io } = require('socket.io-client');
const { captureProject, exportProject, readProject, stageProject, MAX_VIDEO_MB } = require('./server/projects');
const { startServer, waitUntil } = require('./e2e/helpers');
const audio = require('./public/project-audio');

test('portable take alignment prefers session corrections and handles prototype-like authors after JSON transport', () => {
  const scene = JSON.parse('{"takeLatency":{"Host":42,"__proto__":0},"latency":{"Host":600,"constructor":123,"toString":-100,"__proto__":900}}');
  assert.equal(audio.takeLatency(scene, 'Host'), 42);
  assert.equal(audio.takeLatency(scene, 'constructor'), 123);
  assert.equal(audio.takeLatency(scene, 'toString'), -100);
  assert.equal(audio.takeLatency(scene, '__proto__'), 0);
  assert.equal(audio.takeLatency(scene, 'valueOf'), 0);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-project-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = ['video.mp4', 'original.m4a', 'backing.wav', 'track.m4a', 'voice.wav', 'take.webm'];
  for (const name of names) fs.writeFileSync(path.join(dir, name), Buffer.from(`bytes: ${name}`));
  const resolve = url => path.join(dir, url);
  const session = {
    loaded: true, title: 'Проект 「春香」 "test"\nsecond line', kind: 'custom', mode: 'edit',
    trackOrder: ['春香', '__proto__', 'Empty role'], characterClaims: { '春香': 'Алиса' },
    videoUrl: 'video.mp4', externalOriginalUrl: 'original.m4a', backingUrl: 'track.m4a', baseBackingUrl: 'backing.wav',
    originalTrack: 1, backingTrack: 0, videoHasAudio: true,
    audioTracks: [{ index: 0, url: 'track.m4a', language: 'jpn', label: '日本語', codec: 'aac' },
      { index: 1, url: 'video.mp4', language: 'rus', label: 'Русский', codec: 'aac' }],
    audioMetadata: { original: { name: 'Оригинал.wav', duration: 12, size: 20 } },
    projectAudio: { revision: 19, autoDuckEnabled: false, autoDuckAmount: 0.6,
      original: { volume: 1.5, muted: false, solo: true, offset: -0.123 },
      backing: { volume: 0.7, muted: true, solo: false, offset: 1.234 }, dub: { volume: 1.25, muted: false, solo: false } },
    lines: [{ id: 15, character: '春香', caption: '"Привет"\nДругий рядок 🎙️', start: 1.234, end: 3.456,
      claimedBy: 'Алиса', originalAudioUrl: 'voice.wav', audioUrl: 'take.webm', recordedBy: 'Алиса',
      audioStart: -1.5, recordedStart: -2, trimStart: 0.2, trimEnd: 2.6, trimEnabled: false, effect: 'cave', pitch: -4,
      takeSequence: 9, takeCounter: 11, uploadId: 'old-upload', revision: 20 }],
    hostClientId: 'SECRET', passwordHash: 'SECRET', hostToken: 'SECRET', pin: 'SECRET',
    latency: { 'Алиса': 42 }, chat: [{ text: 'private chat' }], onlineUsers: ['Somebody'], deletedLines: []
  };
  return { dir, session, resolve };
}

function archive(snapshot, change = () => {}) {
  const manifest = structuredClone(snapshot.manifest);
  const files = new Map(snapshot.files);
  change(manifest, files);
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(JSON.stringify(manifest)));
  for (const [name, bytes] of files) zip.addFile(name, bytes);
  return zip.toBuffer();
}

test('project round-trip preserves portable state, Unicode, media bytes, sources, tracks, mix and take processing', async t => {
  const f = fixture(t);
  const saved = await exportProject(f.session, f.resolve);
  const loaded = readProject(saved.buffer);
  assert.equal(loaded.manifest.formatVersion, 1);
  const p = loaded.manifest.project;
  assert.equal(p.title, f.session.title);
  assert.deepEqual(p.roles, f.session.trackOrder);
  assert.deepEqual(p.roleClaims, f.session.characterClaims);
  assert.equal(p.lines[0].id, 15);
  assert.equal(p.lines[0].caption, f.session.lines[0].caption);
  assert.equal(p.lines[0].start, 1.234);
  assert.equal(p.lines[0].end, 3.456);
  assert.deepEqual(p.lines[0].take, { asset: p.lines[0].take.asset, audioStart: -1.5, recordedStart: -2,
    trimStart: 0.2, trimEnd: 2.6, trimEnabled: false, effect: 'cave', pitch: -4, recordedBy: 'Алиса' });
  const mix = structuredClone(f.session.projectAudio); delete mix.revision;
  assert.deepEqual(p.mix, mix);
  assert.equal(p.media.originalTrack, 1); assert.equal(p.media.backingTrack, 0);
  assert.deepEqual(p.audioMetadata, f.session.audioMetadata);
  for (const [asset, file] of [[p.media.video, 'video.mp4'], [p.media.original, 'original.m4a'],
    [p.media.backing, 'track.m4a'], [p.media.baseBacking, 'backing.wav'], [p.lines[0].reference, 'voice.wav'], [p.lines[0].take.asset, 'take.webm']]) {
    assert.deepEqual(loaded.files.get(asset), fs.readFileSync(f.resolve(file)));
  }
  const json = JSON.stringify(p);
  for (const excluded of ['SECRET', 'hostClientId', 'passwordHash', 'hostToken', 'onlineUsers', 'private chat',
    'takeCounter', 'takeSequence', 'uploadId', '"latency"', 'deletedLines', 'revision']) assert.equal(json.includes(excluded), false, excluded);
  assert.deepEqual(p.takeLatency, { 'Алиса': 42 });
});

test('project snapshot captures metadata and media before concurrent replacement, deletion and mix edits', async t => {
  const f = fixture(t);
  const expected = captureProject(f.session, f.resolve);
  const saving = exportProject(f.session, f.resolve);
  f.session.title = 'new title'; f.session.lines[0].caption = 'new caption';
  f.session.projectAudio.original.offset = 9;
  fs.writeFileSync(f.resolve('video.mp4'), 'replacement'); fs.rmSync(f.resolve('take.webm'));
  const actual = readProject((await saving).buffer);
  assert.deepEqual(actual.manifest, expected.manifest);
  assert.deepEqual(actual.files, expected.files);
});

test('video-only project with empty roles/lines and unprobed audio is portable', async t => {
  const f = fixture(t);
  const s = { loaded: true, title: '', videoUrl: 'video.mp4', mode: 'edit', lines: [], trackOrder: [] };
  const staged = stageProject((await exportProject(s, f.resolve)).buffer, f.dir);
  t.after(() => staged.rollback());
  assert.deepEqual(staged.fields.lines, []);
  assert.equal(staged.fields.audioTracks, undefined);
  assert.equal(staged.fields.videoHasAudio, undefined);
  assert.equal(staged.fields.mode, 'edit');
});

test('staged project commit uses generated paths and fresh recording identity; rollback preserves unrelated files', async t => {
  const f = fixture(t);
  const bytes = (await exportProject(f.session, f.resolve)).buffer;
  const staged = stageProject(bytes, f.dir);
  assert.ok(fs.existsSync(staged.mediaFiles.find(file => file.video).path));
  const fields = staged.commit();
  const takePath = path.join(f.dir, fields.lines[0].audioUrl.slice('/uploads/'.length));
  const videoPath = path.join(f.dir, fields.videoUrl.slice('/uploads/'.length));
  assert.deepEqual(fs.readFileSync(takePath), fs.readFileSync(f.resolve('take.webm')));
  assert.deepEqual(fs.readFileSync(videoPath), fs.readFileSync(f.resolve('video.mp4')));
  assert.match(fields.lines[0].audioUrl, /^\/uploads\/line_project_/);
  assert.equal(fields.lines[0].takeSequence, undefined);
  assert.equal(fields.lines[0].revision, 0);
  assert.equal(fields.lines[0].uploadId, null);
  assert.equal(fields.takeLatency['Алиса'], 42);
  staged.rollback();
  assert.equal(fs.existsSync(takePath), false); assert.equal(fs.existsSync(videoPath), false);
  assert.equal(fs.existsSync(f.resolve('video.mp4')), true);
});

const invalidCases = [
  ['wrong format', m => { m.format = 'rooms'; }],
  ['missing version', m => { delete m.formatVersion; }],
  ['unsupported version', m => { m.formatVersion = 3; }],
  ['invalid caption type', m => { m.project.lines[0].caption = {}; }],
  ['oversized caption', m => { m.project.lines[0].caption = 'x'.repeat(2001); }],
  ['duplicate line ID', m => { m.project.lines.push(structuredClone(m.project.lines[0])); }],
  ['reversed timing', m => { m.project.lines[0].start = 10; }],
  ['invalid mix', m => { m.project.mix.original.volume = 1.51; }],
  ['invalid source selection', m => { m.project.media.originalTrack = 90; }],
  ['invalid trim', m => { m.project.lines[0].take.trimEnd = 0.1; }],
  ['invalid effect', m => { m.project.lines[0].take.effect = 'made-up'; }],
  ['missing required video', (m, files) => { files.delete(m.project.media.video); }],
  ['missing recording', (m, files) => { files.delete(m.project.lines[0].take.asset); }],
  ['size mismatch', m => { m.assets[0].size++; }],
  ['hash mismatch', m => { m.assets[0].sha256 = '0'.repeat(64); }],
  ['unexpected file', (m, files) => { files.set('evil.html', Buffer.from('<script/>')); }],
  ['video size limit', m => { m.assets[0].size = (MAX_VIDEO_MB + 1) * 1024 * 1024; }]
];
for (const [label, change] of invalidCases) test(`project import rejects ${label} before staging`, t => {
  const f = fixture(t);
  const bytes = archive(captureProject(f.session, f.resolve), change);
  assert.throws(() => stageProject(bytes, f.dir), error => [400, 413].includes(error.status));
  assert.equal(fs.readdirSync(f.dir).some(name => name.startsWith('.project-')), false);
});

test('project import rejects traversal, Windows/absolute paths, encoded paths and symlinks', t => {
  const f = fixture(t); const valid = archive(captureProject(f.session, f.resolve));
  for (const unsafe of ['../escape.wav', '/absolute.wav', 'C:/escape.wav', 'media\\escape.wav', 'media/%2e%2e.wav']) {
    const zip = new AdmZip(valid);
    // addFile normalizes paths; overwrite the encoded entry name to exercise actual unsafe input.
    zip.addFile('bad-entry.wav', Buffer.from('bad'));
    zip.getEntry('bad-entry.wav').entryName = unsafe;
    assert.throws(() => readProject(zip.toBuffer()), error => error.status === 400, unsafe);
  }
  const zip = new AdmZip(valid);
  zip.getEntry('project.json').header.attr = (0xa000 << 16) >>> 0;
  assert.throws(() => readProject(zip.toBuffer()), error => error.status === 400);
});

test('project rejects duplicate ZIP entries and falsified decompression sizes', t => {
  const f = fixture(t); const bytes = archive(captureProject(f.session, f.resolve));
  // Duplicate equal-length names in the central and local headers without a ZIP API normalizing them.
  const zip = new AdmZip(bytes);
  zip.addFile('otherxx.json', Buffer.from('{}'));
  const duplicate = zip.toBuffer();
  let at = duplicate.indexOf(Buffer.from('otherxx.json'));
  while (at >= 0) { Buffer.from('project.json').copy(duplicate, at); at = duplicate.indexOf(Buffer.from('otherxx.json'), at + 1); }
  assert.throws(() => readProject(duplicate), error => error.status === 400);
  const damaged = Buffer.from(bytes);
  for (let offset = 0; offset < damaged.length - 46; offset++) {
    if (damaged.readUInt32LE(offset) === 0x02014b50) { damaged.writeUInt32LE(1, offset + 24); break; }
  }
  assert.throws(() => readProject(damaged), error => error.status === 400);
  assert.throws(() => readProject(Buffer.from('broken ZIP')), error => error.status === 400);
});

test('saving a missing media file fails instead of producing an incomplete archive', async t => {
  const f = fixture(t); fs.rmSync(f.resolve('take.webm'));
  await assert.rejects(exportProject(f.session, f.resolve), error => error.status === 404);
});

describe('projects: real server and media', () => {
  let server, serial = 0;
  const sockets = new Set();
  before(async () => { server = await startServer(); });
  after(async () => { for (const socket of sockets) socket.disconnect(); await server?.cleanup(); });
  async function join(room, nick) {
    const clientId = `${nick}-${++serial}`;
    const socket = io(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true });
    sockets.add(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect_error', reject);
      socket.on('connect', () => socket.emit('join_room', { room, nick, clientId }));
      socket.once('nick_state', state => state.nick === nick ? resolve() : reject(new Error(JSON.stringify(state))));
    });
    return { room, nick, clientId, socket };
  }
  function ack(player, event, data = {}) {
    return new Promise((resolve, reject) => player.socket.timeout(5000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
  }
  async function state(player) { return (await ack(player, 'editor_resync')).session; }
  async function post(player, route, body) {
    return fetch(`http://localhost:${server.port}/api/${route}?room=${player.room}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: player.room, clientId: player.clientId, ...body })
    });
  }
  async function load(player) {
    const response = await post(player, 'load-server-pack', { filename: 'test-scene.zip' });
    assert.equal(response.status, 200, await response.clone().text());
    await waitUntil(async () => typeof (await state(player)).videoHasAudio === 'boolean');
    return state(player);
  }
  async function save(player, sessionId) {
    return post(player, 'export-project', { sessionId: sessionId ?? (await state(player)).activeSessionId });
  }
  async function open(player, bytes, sessionId) {
    const form = new FormData(); form.append('clientId', player.clientId);
    form.append('sessionId', sessionId ?? (await state(player)).activeSessionId ?? '');
    form.append('project', new Blob([bytes]), 'Проект.dubline');
    return fetch(`http://localhost:${server.port}/api/import-project?room=${player.room}`, { method: 'POST', body: form });
  }
  async function media(url) { return Buffer.from(await (await fetch(`http://localhost:${server.port}${url}`)).arrayBuffer()); }

  test('HTTP save/open keeps takes, sources and previous sessions, serves exact bytes, and persists after restart', async () => {
    const host = await join(`project_${++serial}`, 'Host');
    const initial = await load(host);
    host.socket.emit('claim_line', { lineId: 1 });
    await waitUntil(async () => (await state(host)).lines[0].claimedBy === 'Host');
    const reservation = await ack(host, 'reserve_take', { lineId: 1, sessionId: initial.activeSessionId });
    const takeBytes = await media(initial.lines[0].originalAudioUrl);
    const form = new FormData();
    for (const [key, value] of Object.entries({ clientId: host.clientId, userName: host.nick, sessionId: initial.activeSessionId,
      lineId: 1, takeSequence: reservation.takeSequence, uploadId: 'project-take', audioStart: -1, trimStart: 0.1, trimEnd: 1.2 })) form.append(key, value);
    form.append('audio', new Blob([takeBytes]), 'take.wav');
    const upload = await fetch(`http://localhost:${server.port}/api/upload-line-audio?room=${host.room}`, { method: 'POST', body: form });
    assert.equal(upload.status, 200, await upload.clone().text());
    const old = await state(host);
    host.socket.emit('set_latency', { ms: 42 });
    await waitUntil(async () => (await state(host)).latency.Host === 42);
    const saved = await save(host);
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.match(saved.headers.get('content-disposition'), /\.dubline/);
    const bytes = Buffer.from(await saved.arrayBuffer());
    host.socket.emit('set_latency', { ms: 600 });
    await waitUntil(async () => (await state(host)).latency.Host === 600);
    const opened = await open(host, bytes);
    assert.equal(opened.status, 200, await opened.clone().text());
    const next = (await opened.json()).session;
    assert.notEqual(next.activeSessionId, old.activeSessionId);
    assert.equal(next.sessionList.length, 2);
    assert.equal(next.title, old.title);
    assert.deepEqual(next.trackOrder, old.trackOrder);
    assert.deepEqual(next.projectAudio, { ...old.projectAudio, revision: 0 });
    assert.deepEqual(await media(next.videoUrl), await media(old.videoUrl));
    assert.deepEqual(await media(next.backingUrl), await media(old.backingUrl));
    assert.deepEqual(await media(next.lines[0].audioUrl), takeBytes);
    assert.equal(next.lines[0].audioStart, -1); assert.equal(next.lines[0].trimStart, 0.1);
    assert.equal(next.takeLatency.Host, 42);
    assert.equal(next.latency.Host, 600);
    await server.restart();
    await waitUntil(() => host.socket.connected);
    await waitUntil(async () => (await state(host))?.activeSessionId === next.activeSessionId);
    assert.deepEqual(await media((await state(host)).lines[0].audioUrl), takeBytes);
    // A request bound to the old scene cannot delete the imported recording.
    const stale = await post(host, 'delete-line-audio', { sessionId: old.activeSessionId, lineId: 1, userName: host.nick, audioUrl: old.lines[0].audioUrl });
    assert.equal(stale.status, 409);
    host.socket.emit('rename_user', { newName: 'Renamed' });
    await waitUntil(async () => (await state(host)).takeLatency.Renamed === 42);
    assert.equal((await state(host)).takeLatency.Host, undefined);
    host.socket.emit('set_latency', { ms: 100 });
    await waitUntil(async () => (await state(host)).takeLatency.Renamed === 100);
  });

  test('guest cannot export or import; stale project requests cannot affect the active scene', async () => {
    const host = await join(`project_${++serial}`, 'Host'); const s = await load(host);
    const guest = await join(host.room, 'Guest');
    assert.equal((await save(guest, s.activeSessionId)).status, 403);
    assert.equal((await open(guest, Buffer.from('bad'), s.activeSessionId)).status, 403);
    assert.equal((await save(host, 'old-session')).status, 409);
    assert.equal((await open(host, Buffer.from('bad'), 'old-session')).status, 409);
    assert.equal((await state(host)).activeSessionId, s.activeSessionId);
  });

  test('failed schema or playable-media validation leaves existing session and assets intact without staging files', async () => {
    const host = await join(`project_${++serial}`, 'Host'); const s = await load(host);
    const saved = await save(host); assert.equal(saved.status, 200);
    const valid = Buffer.from(await saved.arrayBuffer());
    const snapshot = readProject(valid);
    const beforeFiles = fs.readdirSync(server.dirs.uploads).sort();
    const brokenMedia = archive(snapshot, (manifest, files) => {
      const asset = manifest.assets.find(item => item.path === manifest.project.media.video);
      const bytes = Buffer.from('this is not video'); files.set(asset.path, bytes);
      asset.size = bytes.length; asset.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    });
    for (const bytes of [Buffer.from('bad ZIP'), archive(snapshot, m => { m.formatVersion = 2; }), brokenMedia, archive(snapshot, m => { m.project.lines[0].end = 100; })]) {
      const response = await open(host, bytes);
      assert.equal(response.status, 400, await response.clone().text());
      const current = await state(host);
      assert.equal(current.activeSessionId, s.activeSessionId);
      assert.equal(current.sessionList.length, 1);
      assert.equal(fs.readdirSync(server.dirs.uploads).some(name => name.startsWith('.project-')), false);
      assert.deepEqual(fs.readdirSync(server.dirs.uploads).sort(), beforeFiles);
      assert.ok((await media(current.videoUrl)).length);
    }
  });
});
