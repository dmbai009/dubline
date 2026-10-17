const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { io } = require('socket.io-client');
const http = require('node:http');
const { startServer, waitUntil } = require('../e2e/helpers');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('an absent background cannot keep an invisible solo active in playback, monitoring or export', () => {
  const model = require('../src/public/project-audio');
  const scene = { videoUrl: '/video.mp4', videoHasAudio: true, projectAudio: { original: { volume: .8 }, backing: { solo: true } } };
  const mix = model.normalize(scene);
  assert.deepEqual(model.gains(mix, model.sources(scene)), { original: .8, backing: 0, dub: 1 });
  scene.backingUrl = '/background.m4a';
  assert.deepEqual(model.gains(mix, model.sources(scene)), { original: 0, backing: 1, dub: 0 });
  assert.equal(mix.backing.solo, true);
});

test('background replacement is host-authorized, atomic, independent of embedded audio and preserves takes through project save/open', { timeout: 60000 }, async t => {
  const server = await startServer(); t.after(() => server.cleanup());
  const origin = `http://localhost:${server.port}`, room = 'background-test';
  async function join(nick) {
    const clientId = crypto.randomUUID(), socket = io(origin, { transports: ['websocket'], forceNew: true });
    t.after(() => socket.disconnect());
    await new Promise(resolve => socket.once('connect', resolve));
    const joined = new Promise(resolve => socket.on('nick_state', value => { if (value.nick === nick) resolve(); }));
    socket.emit('join_room', { room, nick, clientId }); await joined;
    socket.on('connect', () => socket.emit('join_room', { room, nick, clientId }));
    return { socket, clientId, nick };
  }
  const host = await join('Host'), guest = await join('Guest');
  const ack = (player, event, data = {}) => new Promise((resolve, reject) => player.socket.timeout(5000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
  const state = async () => (await ack(host, 'editor_resync')).session;
  const post = (player, route, data) => fetch(`${origin}/api/${route}?room=${room}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room, userName: player.nick, clientId: player.clientId, ...data }) });
  const loaded = await post(host, 'load-server-pack', { filename: 'test-scene.zip' });
  assert.equal(loaded.status, 200, await loaded.clone().text());
  await waitUntil(async () => (await state()).audioTracks?.length > 0);
  let scene = await state();
  const fields = value => ({ sessionId: value.activeSessionId, baseBackingUrl: value.baseBackingUrl, backingUrl: value.backingUrl, backingTrack: value.backingTrack });
  const media = async url => Buffer.from(await (await fetch(origin + url)).arrayBuffer());
  const sound = await media(scene.lines[0].originalAudioUrl);
  host.socket.emit('claim_line', { sessionId: scene.activeSessionId, lineId: 1 });
  await waitUntil(async () => (await state()).lines[0].claimedBy === 'Host');
  const reservation = await ack(host, 'reserve_take', { sessionId: scene.activeSessionId, lineId: 1 });
  const take = new FormData();
  Object.entries({ clientId: host.clientId, userName: 'Host', sessionId: scene.activeSessionId, lineId: 1, takeSequence: reservation.takeSequence, uploadId: crypto.randomUUID(), audioStart: 2.8, trimStart: .1, trimEnd: 1.2 }).forEach(([key, value]) => take.append(key, value));
  take.append('audio', new Blob([sound]), 'take.wav');
  const recorded = await fetch(`${origin}/api/upload-line-audio?room=${room}`, { method: 'POST', body: take });
  assert.equal(recorded.status, 200, await recorded.clone().text());
  scene = await state();
  const originalLines = structuredClone(scene.lines), recordedHash = digest(await media(scene.lines[0].audioUrl));
  const unchanged = async () => { const now = await state(); assert.deepEqual(now.lines, originalLines); assert.equal(digest(await media(now.lines[0].audioUrl)), recordedHash); return now; };
  const upload = async (player, expected, bytes = sound, name = 'Background.wav') => {
    const form = new FormData();
    Object.entries({ clientId: player.clientId, ...fields(expected) }).forEach(([key, value]) => form.append(key, value));
    form.append('intershum', new Blob([bytes]), name);
    return fetch(`${origin}/api/backing-source?room=${room}`, { method: 'POST', body: form });
  };
  assert.equal((await upload(guest, scene)).status, 403);
  assert.equal((await post(guest, 'backing-source/remove', fields(scene))).status, 403);
  assert.equal((await upload(host, { ...scene, activeSessionId: 'old-scene' })).status, 409);
  const broken = await upload(host, scene, Buffer.from('not audio')); assert.equal(broken.status, 400);
  assert.equal((await unchanged()).backingUrl, scene.backingUrl);
  // Hold a real multipart stream after authorization; no FFmpeg mocks or blind retries.
  const boundary = 'dubline-' + crypto.randomUUID();
  const prefix = Buffer.from(Object.entries({ clientId: host.clientId, ...fields(scene) }).map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('') + `--${boundary}\r\nContent-Disposition: form-data; name="intershum"; filename="Delayed.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  // Responses can finish before their temporary directories are removed. Wait
  // for this request's directory, never a leftover from the rejected upload.
  const previousIncoming = new Set(fs.readdirSync(server.dirs.data));
  let request;
  const delayed = new Promise((resolve, reject) => {
    request = http.request(`${origin}/api/backing-source?room=${room}`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': prefix.length + sound.length + suffix.length } }, response => {
      let text = ''; response.on('data', chunk => text += chunk); response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject); request.write(prefix); request.write(sound.subarray(0, 32));
  });
  await waitUntil(() => fs.readdirSync(server.dirs.data).some(name => name.startsWith('.incoming-') && !previousIncoming.has(name)));
  assert.equal((await upload(host, scene)).status, 409, 'a concurrent job cannot replace the current preparation');
  assert.equal((await post(host, 'backing-source/remove', fields(scene))).status, 409);
  host.socket.emit('host_set_audio_tracks', { sessionId: scene.activeSessionId, original: 0, backing: 0 });
  await waitUntil(async () => (await state()).backingTrack === 0);
  request.end(Buffer.concat([sound.subarray(32), suffix]));
  const obsolete = await delayed; assert.equal(obsolete.status, 409, obsolete.text);
  assert.equal(JSON.parse(obsolete.text).key, 'backing.changed'); await unchanged();
  await waitUntil(() => !fs.readdirSync(server.dirs.data).some(name => name.startsWith('.incoming-')));
  host.socket.emit('host_set_audio_tracks', { sessionId: scene.activeSessionId, original: 0, backing: -1 });
  await waitUntil(async () => (await state()).backingTrack === -1); scene = await state();
  const beforeDisconnect = scene.backingUrl;
  let disconnectedRequest;
  const cancelled = new Promise((resolve, reject) => {
    disconnectedRequest = http.request(`${origin}/api/backing-source?room=${room}`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': prefix.length + sound.length + suffix.length } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    disconnectedRequest.on('error', reject); disconnectedRequest.write(prefix); disconnectedRequest.write(sound.subarray(0, 32));
  });
  await waitUntil(() => fs.readdirSync(server.dirs.data).some(name => name.startsWith('.incoming-')));
  host.socket.disconnect();
  await waitUntil(async () => (await fetch(`${origin}/api/media-manifest?${new URLSearchParams({ room, sessionId: scene.activeSessionId, clientId: host.clientId, url: scene.videoUrl })}`)).status === 403);
  disconnectedRequest.end(Buffer.concat([sound.subarray(32), suffix]));
  assert.notEqual(await cancelled, 200, 'disconnect aborts the authorized upload before publishing');
  await waitUntil(() => !fs.readdirSync(server.dirs.data).some(name => name.startsWith('.incoming-')));
  host.socket.connect(); await waitUntil(() => host.socket.connected);
  await waitUntil(async () => (await state())?.loaded);
  assert.equal((await unchanged()).backingUrl, beforeDisconnect);
  const prepared = await upload(host, scene); assert.equal(prepared.status, 200, await prepared.clone().text());
  scene = await unchanged(); const first = scene.baseBackingUrl;
  assert.match(first, /^\/uploads\/backing_[a-f0-9-]+\/backing\.m4a$/); assert.equal(scene.backingUrl, first);
  assert.equal(scene.audioMetadata.backing.name, 'Background.wav'); assert.ok(scene.audioMetadata.backing.duration > 1);
  assert.equal((await upload(host, { ...scene, backingUrl: 'old-url' })).status, 409);
  const replaced = await upload(host, scene, sound, 'Replacement.wav'); assert.equal(replaced.status, 200);
  scene = await unchanged(); assert.notEqual(scene.baseBackingUrl, first); assert.equal(scene.audioMetadata.backing.name, 'Replacement.wav');
  assert.equal(fs.existsSync(path.join(server.dirs.uploads, first.slice('/uploads/'.length))), false, 'unused generated source is cleaned');
  const second = scene.baseBackingUrl;
  host.socket.emit('host_set_audio_tracks', { sessionId: scene.activeSessionId, original: 0, backing: 0 });
  await waitUntil(async () => (await state()).backingTrack === 0);
  scene = await state(); const embedded = scene.backingUrl;
  assert.notEqual(embedded, second); assert.equal(scene.baseBackingUrl, second);
  assert.equal((await post(host, 'backing-source/remove', fields(scene))).status, 200);
  scene = await unchanged(); assert.equal(scene.backingUrl, embedded); assert.equal(scene.backingTrack, 0); assert.equal(scene.baseBackingUrl, '');
  assert.equal((await post(host, 'backing-source/remove', fields(scene))).status, 409);
  const last = await upload(host, scene, sound, 'Saved background.wav'); assert.equal(last.status, 200);
  scene = await unchanged(); assert.equal(scene.backingTrack, -1);
  const backgroundHash = digest(await media(scene.backingUrl));
  const barrier = await ack(host, 'snapshot_request', { purpose: 'project', sessionId: scene.activeSessionId });
  const saved = await post(host, 'export-project', { sessionId: scene.activeSessionId, download: true, barrierToken: barrier.token, forceSnapshot: true });
  assert.equal(saved.status, 200, await saved.clone().text());
  const archive = await fetch(origin + (await saved.json()).downloadUrl, { headers: { Cookie: 'dubline_client=' + host.clientId } });
  assert.equal(archive.status, 200); const bytes = await archive.arrayBuffer();
  const form = new FormData(); form.append('clientId', host.clientId); form.append('sessionId', scene.activeSessionId); form.append('project', new Blob([bytes]), 'Scene.dubline');
  const opened = await fetch(`${origin}/api/import-project?room=${room}`, { method: 'POST', body: form });
  assert.equal(opened.status, 200, await opened.clone().text());
  const restored = await state(); assert.notEqual(restored.activeSessionId, scene.activeSessionId);
  assert.equal(restored.lines.length, originalLines.length);
  for (let i = 0; i < originalLines.length; i++) for (const key of ['caption', 'character', 'start', 'end', 'audioStart', 'trimStart', 'trimEnd', 'recordedBy']) assert.equal(restored.lines[i][key], originalLines[i][key], key);
  assert.equal(digest(await media(restored.lines[0].audioUrl)), recordedHash);
  assert.equal(digest(await media(restored.backingUrl)), backgroundHash);
  assert.equal(restored.audioMetadata.backing.name, 'Saved background.wav');
  await server.restart(); await waitUntil(() => host.socket.connected);
  await waitUntil(async () => (await state())?.loaded);
  assert.equal(digest(await media((await state()).lines[0].audioUrl)), recordedHash);
  assert.equal(digest(await media((await state()).backingUrl)), backgroundHash);
  const oldSource = path.join(server.dirs.uploads, scene.baseBackingUrl.slice('/uploads/'.length));
  assert.equal(fs.existsSync(oldSource), true, 'the inactive scene still owns its background');
  host.socket.emit('host_delete_session', { id: scene.activeSessionId });
  await waitUntil(() => !fs.existsSync(oldSource));
  assert.equal(digest(await media((await state()).lines[0].audioUrl)), recordedHash);
  assert.equal(digest(await media((await state()).backingUrl)), backgroundHash);
});
