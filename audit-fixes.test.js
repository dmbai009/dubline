// Exercise the public socket/HTTP protocol against isolated, persisted rooms.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const AdmZip = require('adm-zip');
const { io } = require('socket.io-client');
const { startServer, buildFixturePack, waitUntil, wait } = require('./e2e/helpers');

describe('audit: scene and take integrity', () => {
  let server, serial = 0;
  const sockets = new Set();
  before(async () => { server = await startServer(); });
  after(async () => { for (const socket of sockets) socket.disconnect(); await server?.cleanup(); });
  async function join(room, nick, clientId = `${nick}-${++serial}`) {
    const socket = io(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true });
    sockets.add(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect_error', reject);
      socket.on('connect', () => socket.emit('join_room', { room, nick: playerNick(), clientId }));
      socket.once('nick_state', state => state.nick === nick ? resolve() : reject(new Error(JSON.stringify(state))));
    });
    const player = { socket, room, nick, clientId };
    function playerNick() { return socket.connected && socket.__confirmedNick || nick; }
    socket.on('nick_state', state => { if (state.nick) socket.__confirmedNick = state.nick; });
    return player;
  }
  function ack(player, event, payload = {}) {
    return new Promise((resolve, reject) => player.socket.timeout(5000).emit(event, payload,
      (err, result) => err ? reject(err) : resolve(result)));
  }
  async function state(player) { return (await ack(player, 'editor_resync')).session; }
  async function scene(nick = 'Host') {
    const player = await join(`audit_${++serial}`, nick);
    const response = await fetch(`http://localhost:${server.port}/api/load-server-pack?room=${player.room}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'test-scene.zip', clientId: player.clientId, room: player.room })
    });
    assert.equal(response.status, 200, await response.clone().text());
    return player;
  }
  async function claim(player, lineId = 1) {
    player.socket.emit('claim_line', { lineId });
    await waitUntil(async () => (await state(player)).lines.find(line => line.id === lineId).claimedBy === player.nick);
  }
  async function reserve(player, lineId = 1, sessionId) {
    const result = await ack(player, 'reserve_take', { lineId, sessionId: sessionId || (await state(player)).activeSessionId });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.takeSequence;
  }
  async function upload(player, sequence, { sessionId, lineId = 1, uploadId = `take-${sequence}`, audioStart = -3, nick = player.nick } = {}) {
    const form = new FormData();
    for (const [key, value] of Object.entries({ lineId, userName: nick, clientId: player.clientId, sessionId: sessionId || (await state(player)).activeSessionId, takeSequence: sequence, uploadId, audioStart })) form.append(key, value);
    form.append('audio', new Blob([`take body ${uploadId}`]), 'take.webm');
    const response = await fetch(`http://localhost:${server.port}/api/upload-line-audio?room=${player.room}`, { method: 'POST', body: form });
    return { status: response.status, body: await response.json() };
  }
  async function remove(player, snapshot, lineId = 1) {
    const line = snapshot.lines.find(item => item.id === lineId);
    const response = await fetch(`http://localhost:${server.port}/api/delete-line-audio`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: player.room, clientId: player.clientId, userName: player.nick, lineId, sessionId: snapshot.activeSessionId, audioUrl: line.audioUrl })
    });
    return response.status;
  }
  async function pack(player, buffer, name = 'same.zip') {
    const form = new FormData(); form.append('clientId', player.clientId); form.append('pack', new Blob([buffer]), name);
    const response = await fetch(`http://localhost:${server.port}/api/upload-pack?room=${player.room}`, { method: 'POST', body: form });
    return { status: response.status, body: await response.json() };
  }
  async function bytes(url) { return Buffer.from(await (await fetch(`http://localhost:${server.port}${url}`)).arrayBuffer()); }

  test('same archive name in two rooms preserves the first scene media and source ZIP', async () => {
    const first = await scene(), second = await scene();
    const buffer = fs.readFileSync(buildFixturePack());
    const a = (await pack(first, buffer)).body.session;
    const oldVideo = await bytes(a.videoUrl), oldZip = await bytes(a.zipUrl);
    const changed = new AdmZip(buffer);
    changed.updateFile('dub_video.mp4', Buffer.concat([oldVideo, Buffer.from('new version')]));
    const b = (await pack(second, changed.toBuffer())).body.session;
    assert.notEqual(a.videoUrl, b.videoUrl); assert.notEqual(a.zipUrl, b.zipUrl);
    assert.deepEqual(await bytes(a.videoUrl), oldVideo); assert.deepEqual(await bytes(a.zipUrl), oldZip);
    assert.notDeepEqual(await bytes(b.videoUrl), oldVideo);
    const again = (await pack(first, changed.toBuffer())).body.session;
    assert.equal(again.videoUrl, b.videoUrl);
    assert.deepEqual(await bytes(a.videoUrl), oldVideo);
  });
  test('missing video and damaged ZIP leave existing scene and library intact, with no staging leftovers', async () => {
    const host = await scene(); const original = fs.readFileSync(buildFixturePack());
    const a = (await pack(host, original)).body.session;
    const bad = new AdmZip(); bad.addFile('line_1.ini', Buffer.from('caption = Lost'));
    for (const buffer of [bad.toBuffer(), Buffer.from('broken zip')]) {
      assert.equal((await pack(host, buffer)).status, 400);
      assert.equal((await state(host)).activeSessionId, a.activeSessionId);
      assert.deepEqual(await bytes(a.zipUrl), original);
      assert.deepEqual(fs.readFileSync(`${server.dirs.packs}/same.zip`), original);
      assert.equal(fs.readdirSync(server.dirs.uploads).some(name => name.startsWith('.pack-')), false);
    }
  });
  test('pre-upgrade scenes keep their source archive when a library filename is replaced', async () => {
    const host = await scene(); const original = fs.readFileSync(buildFixturePack());
    const a = (await pack(host, original)).body.session;
    await wait(1300); await server.stop();
    const file = `${server.dirs.data}/rooms.json`;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved[host.room].zipUrl = saved[host.room].sessions[a.activeSessionId].zipUrl = '/packs/same.zip';
    fs.writeFileSync(file, JSON.stringify(saved)); await server.start();
    await waitUntil(async () => { try { return (await state(host)).zipUrl === '/packs/same.zip'; } catch { return false; } });
    const changed = new AdmZip(original); changed.updateFile('001.ini', Buffer.from('caption = Updated\ndub_characters=["Hero"]\ndub_timestamps=[3,4.5]\n'));
    assert.equal((await pack(host, changed.toBuffer())).status, 200);
    host.socket.emit('host_switch_session', { id: a.activeSessionId });
    await waitUntil(async () => (await state(host)).activeSessionId === a.activeSessionId);
    const old = await state(host); assert.match(old.zipUrl, /^\/uploads\/pack_source_/);
    assert.deepEqual(await bytes(old.zipUrl), original);
  });
  test('a delayed deletion cannot erase a take from a different session', async () => {
    const host = await scene(); await claim(host);
    assert.equal((await upload(host, await reserve(host))).status, 200);
    const old = await state(host);
    await pack(host, fs.readFileSync(buildFixturePack())); await claim(host);
    const current = await upload(host, await reserve(host));
    assert.equal(await remove(host, old), 409);
    assert.equal((await state(host)).lines[0].audioUrl, current.body.audioUrl);
  });
  test('a delayed deletion and take-properties change cannot erase or shift a newer take', async () => {
    const host = await scene(); await claim(host);
    await upload(host, await reserve(host)); const old = await state(host);
    const fresh = await upload(host, await reserve(host));
    assert.equal(await remove(host, old), 409);
    host.socket.emit('set_take_props', { lineId: 1, sessionId: old.activeSessionId, audioUrl: old.lines[0].audioUrl, audioStart: 9 });
    const line = (await state(host)).lines[0];
    assert.equal(line.audioUrl, fresh.body.audioUrl); assert.equal(line.audioStart, -3);
  });
  test('reverse delivery, retries, and restart preserve the newest recorded take', async () => {
    const host = await scene(); await claim(host);
    const first = await reserve(host), second = await reserve(host);
    const fresh = await upload(host, second);
    const late = await upload(host, first);
    assert.equal(late.body.superseded, true);
    assert.equal((await upload(host, second)).body.duplicate, true);
    assert.equal((await state(host)).lines[0].audioUrl, fresh.body.audioUrl);
    await server.restart(); await waitUntil(async () => host.socket.connected);
    await waitUntil(async () => { try { return (await state(host)).loaded; } catch { return false; } });
    assert.equal((await upload(host, first)).body.superseded, true);
    assert.equal((await state(host)).lines[0].audioUrl, fresh.body.audioUrl);
  });
  test('an upload retry cannot resurrect an intentionally deleted take', async () => {
    const host = await scene(); await claim(host); const sequence = await reserve(host);
    await upload(host, sequence); assert.equal(await remove(host, await state(host)), 200);
    assert.equal((await upload(host, sequence)).body.superseded, true);
    assert.equal((await state(host)).lines[0].audioUrl, null);
  });
  test('acknowledged take reservations survive an immediate server shutdown', async () => {
    const host = await scene(); await claim(host); const sequence = await reserve(host);
    await server.stop(); await server.start();
    await waitUntil(async () => { try { return (await state(host)).lines[0].takeCounter === sequence; } catch { return false; } });
    assert.equal((await upload(host, sequence)).status, 200);
  });
  test('an unrelated player cannot delete a released take; its author and the host can', async () => {
    const host = await scene(), bob = await join(host.room, 'Bob'), carol = await join(host.room, 'Carol');
    await claim(bob); await upload(bob, await reserve(bob)); bob.socket.emit('unclaim_line', { lineId: 1 });
    await waitUntil(async () => !(await state(bob)).lines[0].claimedBy);
    const snapshot = await state(bob);
    assert.equal(await remove(carol, snapshot), 403); assert.equal(await remove(bob, snapshot), 200);
    await claim(bob); await upload(bob, await reserve(bob));
    assert.equal(await remove(host, await state(host)), 200);
  });
  test('renaming updates inactive scenes, take authors, latency and trash; persisted after restart', async () => {
    const host = await scene(), bob = await join(host.room, 'Bob');
    await claim(bob); await upload(bob, await reserve(bob));
    bob.socket.emit('claim_line', { lineId: 2 }); bob.socket.emit('set_latency', { ms: 120 });
    await state(bob); host.socket.emit('host_delete_lines', { lineIds: [2] }); await state(host);
    const a = (await state(host)).activeSessionId;
    await pack(host, fs.readFileSync(buildFixturePack()));
    bob.socket.emit('rename_user', { newName: 'Bobby' });
    await new Promise(resolve => bob.socket.once('nick_state', resolve)); bob.nick = 'Bobby';
    host.socket.emit('host_switch_session', { id: a });
    await waitUntil(async () => (await state(host)).activeSessionId === a);
    assert.equal((await state(host)).lines[0].recordedBy, 'Bobby');
    assert.equal((await state(host)).lines[0].claimedBy, 'Bobby');
    assert.equal((await state(host)).latency.Bobby, 120);
    host.socket.emit('host_trash_restore', { lineIds: [2] }); await state(host);
    assert.equal((await state(host)).lines.find(line => line.id === 2).claimedBy, 'Bobby');
    await server.restart(); await waitUntil(async () => host.socket.connected);
    await waitUntil(async () => { try { return (await state(host)).loaded; } catch { return false; } });
    assert.equal((await state(host)).lines[0].recordedBy, 'Bobby');
  });
  test('resetting a take at frame zero preserves its negative preparation start', async () => {
    const host = await scene(); await claim(host);
    const snapshot = await state(host);
    // Model a source line at 0:00 through the collaborative editor.
    host.socket.emit('set_session_mode', { mode: 'edit' }); await state(host);
    await ack(host, 'editor_update_line', { lineId: 1, revision: 0, sessionId: snapshot.activeSessionId, start: 0, end: 1.5 });
    host.socket.emit('set_session_mode', { mode: 'dub' }); await state(host);
    await upload(host, await reserve(host));
    const current = (await state(host)).lines[0];
    host.socket.emit('set_take_props', { lineId: 1, sessionId: snapshot.activeSessionId, audioUrl: current.audioUrl, audioStart: -3 });
    assert.equal((await state(host)).lines[0].audioStart, -3);
    host.socket.emit('set_take_props', { lineId: 1, sessionId: snapshot.activeSessionId, audioUrl: current.audioUrl, audioStart: -99 });
    assert.equal((await state(host)).lines[0].audioStart, -5);
    host.socket.emit('set_take_props', { lineId: 1, sessionId: snapshot.activeSessionId, audioUrl: current.audioUrl, audioStart: current.recordedStart });
    assert.equal((await state(host)).lines[0].audioStart, -3);
  });
  for (const length of [499, 500, 501, 2000, 2001]) test(`caption length ${length} is preserved or explicitly refused`, async () => {
    const host = await scene(); host.socket.emit('set_session_mode', { mode: 'edit' });
    const snapshot = await state(host), caption = 'Я'.repeat(length);
    const result = await ack(host, 'editor_update_line', { lineId: 1, revision: 0, sessionId: snapshot.activeSessionId, caption });
    assert.equal(result.ok, length <= 2000);
    if (length <= 2000) assert.equal((await state(host)).lines[0].caption, caption);
    else { assert.equal(result.reason, 'caption'); assert.equal((await state(host)).lines[0].caption, snapshot.lines[0].caption); }
  });
  test('JSON-escaped captions, titles and roles survive pack import without losing punctuation', async () => {
    const host = await scene(); const zip = new AdmZip(fs.readFileSync(buildFixturePack()));
    const caption = 'Кавычки "да"\nO\'Brien, путь C:\\voice\\new', role = 'O\'Brien, "Герой"', title = 'Сцена "первая"';
    zip.updateFile('001.ini', Buffer.from(`caption = ${JSON.stringify(caption)}\ndub_characters = ${JSON.stringify([role])}\ndub_timestamps = [3,4.5]\n`));
    zip.addFile('_pack_info.ini', Buffer.from(`title = ${JSON.stringify(title)}\n`));
    const result = await pack(host, zip.toBuffer()); assert.equal(result.status, 200);
    assert.equal(result.body.session.lines[0].caption, caption); assert.equal(result.body.session.lines[0].character, role);
    assert.equal(result.body.session.title, title);
    const exported = await fetch(`http://localhost:${server.port}/api/export-voxalike-pack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: host.room, clientId: host.clientId })
    });
    assert.equal(exported.status, 200, await exported.clone().text());
    const reimported = await pack(host, Buffer.from(await exported.arrayBuffer()), 'roundtrip.zip');
    assert.equal(reimported.status, 200); assert.equal(reimported.body.session.lines[0].caption, caption);
    assert.equal(reimported.body.session.lines[0].character, role); assert.equal(reimported.body.session.title, title);
  });
  test('prototype-like room, nick and role names behave as ordinary user data across restart', async () => {
    const host = await join('__proto__', 'constructor');
    await pack(host, fs.readFileSync(buildFixturePack())); host.socket.emit('set_session_mode', { mode: 'edit' });
    const sessionId = (await state(host)).activeSessionId;
    for (const character of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const result = await ack(host, 'editor_create_line', { sessionId, character, caption: character, start: 0, end: 1 });
      assert.equal(result.ok, true);
      host.socket.emit('claim_character', { character });
      assert.equal((await state(host)).characterClaims[character], 'constructor');
    }
    await server.restart(); await waitUntil(async () => host.socket.connected);
    await waitUntil(async () => { try { return (await state(host)).loaded; } catch { return false; } });
    assert.equal((await state(host)).characterClaims.__proto__, 'constructor');
    assert.equal((await state(host)).characterClaims.constructor, 'constructor');
  });
});
