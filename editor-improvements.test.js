const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { io } = require('socket.io-client');
const { startServer, waitUntil, wait } = require('./e2e/helpers');

describe('Track structure, protected timings and room moderators on the real server', () => {
  let server, serial = 0; const sockets = [];
  before(async () => { server = await startServer(); });
  after(async () => { sockets.forEach(socket => socket.disconnect()); await server?.cleanup(); });
  const ack = (player, event, data = {}) => new Promise((resolve, reject) => player.socket.timeout(5000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
  const state = async player => (await ack(player, 'editor_resync')).session;
  async function join(room, nick, clientId = `${nick}-${++serial}`) {
    const socket = io(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true }); sockets.push(socket);
    const player = { socket, room, nick, clientId };
    await new Promise((resolve, reject) => {
      socket.once('connect_error', reject); socket.on('connect', () => socket.emit('join_room', { room, nick, clientId }));
      socket.once('nick_state', data => data.nick === nick ? resolve() : reject(new Error(JSON.stringify(data))));
    }); return player;
  }
  async function scene(mode = 'edit') {
    const host = await join(`improvements-${++serial}`, 'Host');
    const response = await fetch(`http://localhost:${server.port}/api/load-server-pack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'test-scene.zip', clientId: host.clientId, room: host.room }) });
    assert.equal(response.status, 200);
    host.socket.emit('set_session_mode', { mode, sessionId: (await state(host)).activeSessionId });
    await waitUntil(async () => (await state(host)).mode === mode); return host;
  }
  function operation(snapshot, payload = {}) { return { ...payload, sessionId: snapshot.activeSessionId, operationId: `improvement-${++serial}`, operationEpoch: snapshot.editorProtocol.epoch, operationTime: snapshot.editorProtocol.serverTime }; }
  const patch = (line, changes) => ({ lineId: line.id, revision: line.revision || 0, base: { caption: line.caption, start: line.start, end: line.end, character: line.character }, ...changes });
  async function grant(host, player) { assert.equal((await ack(host, 'host_grant_moderator', { nick: player.nick })).ok, true); return (await state(host)).moderators.find(entry => entry.nick === player.nick); }
  async function upload(host, lineId) {
    const snapshot = await state(host), sessionId = snapshot.activeSessionId;
    host.socket.emit('claim_line', { lineId, sessionId }); await waitUntil(async () => (await state(host)).lines.find(line => line.id === lineId).claimedBy === host.nick);
    const reserve = await ack(host, 'reserve_take', { lineId, sessionId }); assert.equal(reserve.ok, true);
    const form = new FormData();
    for (const [key, value] of Object.entries({ clientId: host.clientId, userName: host.nick, lineId, sessionId, takeSequence: reserve.takeSequence, uploadId: `upload-${++serial}`, audioStart: snapshot.lines.find(line => line.id === lineId).start - .5 })) form.append(key, value);
    form.append('audio', new Blob(['recorded take fixture']), 'take.webm');
    const response = await fetch(`http://localhost:${server.port}/api/upload-line-audio?room=${host.room}`, { method: 'POST', body: form }); assert.equal(response.status, 200, await response.clone().text());
    return (await state(host)).lines.find(line => line.id === lineId);
  }
  function deletion(snapshot, character, action = 'trash', target) {
    return { character, action, target, createTarget: true, trackOrder: snapshot.trackOrder, expectedClaims: { from: snapshot.characterClaims[character] || null, to: snapshot.characterClaims[target] || null },
      lines: snapshot.lines.filter(line => line.character === character).map(line => ({ lineId: line.id, revision: line.revision || 0, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision || 0, claimedBy: line.claimedBy })) };
  }
  test('reorder is idempotent, scoped, synchronized, undoable and does not alter any cue', async () => {
    const host = await scene(), guest = await join(host.room, 'Guest'), initial = await state(host);
    const request = operation(initial, { character: 'Friend', before: 'Hero', trackOrder: initial.trackOrder });
    const result = await ack(guest, 'editor_reorder_track', request); assert.equal(result.ok, true);
    assert.deepEqual(await ack(guest, 'editor_reorder_track', request), result);
    const saved = await state(host); assert.deepEqual(saved.trackOrder, ['Friend', 'Hero']); assert.deepEqual(saved.lines, initial.lines);
    assert.equal((await ack(host, 'editor_reorder_track', operation(saved, { character: 'Hero', before: 'Friend', trackOrder: initial.trackOrder }))).reason, 'conflict');
    assert.equal((await ack(guest, 'editor_undo', operation(saved))).undone, 1); assert.deepEqual((await state(host)).trackOrder, initial.trackOrder);
  });
  test('empty track deletion and Undo preserve original insertion order', async () => {
    const host = await scene(); await ack(host, 'editor_add_track', operation(await state(host), { character: 'Empty' }));
    const snapshot = await state(host); assert.equal((await ack(host, 'editor_delete_track', operation(snapshot, deletion(snapshot, 'Empty')))).ok, true);
    assert.equal((await state(host)).trackOrder.includes('Empty'), false);
    assert.equal((await ack(host, 'editor_undo', operation(await state(host)))).undone, 1);
    assert.deepEqual((await state(host)).trackOrder, snapshot.trackOrder);
  });
  for (const target of ['Friend', 'New role']) test(`transfer to ${target} is atomic, idempotent, retains all source fields and can be undone`, async () => {
    const host = await scene(), initial = await state(host), payload = operation(initial, deletion(initial, 'Hero', 'transfer', target));
    const result = await ack(host, 'editor_delete_track', payload); assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(await ack(host, 'editor_delete_track', payload), result);
    const moved = await state(host); assert.equal(moved.trackOrder.includes('Hero'), false);
    for (const old of initial.lines.filter(line => line.character === 'Hero')) {
      const line = moved.lines.find(item => item.id === old.id); assert.deepEqual(line, { ...old, character: target, revision: (old.revision || 0) + 1 });
    }
    assert.ok((await ack(host, 'editor_undo', operation(moved))).undone > 0); assert.deepEqual((await state(host)).trackOrder, initial.trackOrder);
    assert.deepEqual((await state(host)).lines.map(({ revision, ...line }) => line), initial.lines.map(({ revision, ...line }) => line));
  });
  test('changed captions, takes, timing or claims invalidate the whole track deletion', async () => {
    const host = await scene(), initial = await state(host), payload = operation(initial, deletion(initial, 'Hero'));
    await ack(host, 'editor_update_line', operation(initial, patch(initial.lines[0], { caption: 'Changed while dialog open' })));
    assert.equal((await ack(host, 'editor_delete_track', payload)).reason, 'conflict');
    const snapshot = await state(host); assert.equal(snapshot.lines.length, initial.lines.length); assert.deepEqual(snapshot.trackOrder, initial.trackOrder);
  });
  test('trash restoration restores the removed track and keeps take URLs playable', async () => {
    const host = await scene(), initial = await state(host);
    assert.equal((await ack(host, 'editor_delete_track', operation(initial, deletion(initial, 'Hero')))).ok, true);
    const removed = await state(host); assert.equal(removed.lines.length, 2); assert.equal(removed.trackOrder.includes('Hero'), false);
    const trash = await ack(host, 'host_trash_list'); assert.equal(trash.length, 2);
    host.socket.emit('host_trash_restore', { sessionId: initial.activeSessionId, lineIds: trash.map(item => item.lineId) });
    await waitUntil(async () => (await state(host)).lines.length === 4);
    const restored = await state(host); assert.deepEqual(restored.trackOrder, initial.trackOrder); assert.deepEqual(restored.lines, initial.lines);
    const friend = restored.lines.find(line => line.audioUrl); if (friend) assert.equal((await fetch(server.url(friend.audioUrl))).ok, true);
  });
  test('purged track deletion is reported as skipped instead of restoring an empty ghost track', async () => {
    const host = await scene(), initial = await state(host); await ack(host, 'editor_delete_track', operation(initial, deletion(initial, 'Hero')));
    const entries = await ack(host, 'host_trash_list'); host.socket.emit('host_trash_purge', { sessionId: initial.activeSessionId, lineIds: entries.map(item => item.lineId), entries });
    await waitUntil(async () => !(await ack(host, 'host_trash_list')).length);
    const result = await ack(host, 'editor_undo', operation(await state(host))); assert.equal(result.undone, 0); assert.equal(result.skipped, 2); assert.equal((await state(host)).trackOrder.includes('Hero'), false);
  });
  for (const actor of ['Host', 'Moderator', 'Guest']) test(`timing protection blocks ${actor}'s direct and delayed timing/create/Undo operations but permits text and vertical moves`, async () => {
    const host = await scene(), moderator = await join(host.room, 'Moderator'), guest = await join(host.room, 'Guest'); await grant(host, moderator);
    const player = { Host: host, Moderator: moderator, Guest: guest }[actor];
    const initial = await state(host), first = initial.lines[0];
    assert.equal((await ack(player, 'editor_update_line', operation(initial, patch(first, { start: first.start + .2 })))).ok, true);
    const beforeLock = await state(host), line = beforeLock.lines[0];
    const late = operation(beforeLock, patch(line, { start: line.start + .1 }));
    assert.equal((await ack(moderator, 'set_protect_timings', { sessionId: initial.activeSessionId, enabled: true })).ok, true);
    assert.equal((await ack(player, 'editor_update_line', late)).reason, 'timingsProtected');
    assert.equal((await ack(player, 'editor_create_line', operation(beforeLock, { character: 'Hero', start: 0, end: 1, caption: 'Forbidden' }))).reason, 'timingsProtected');
    assert.equal((await ack(player, 'editor_undo', operation(await state(host)))).reason, 'timingsProtected');
    assert.equal((await ack(player, 'editor_update_line', operation(await state(host), patch(line, { caption: 'Allowed', character: 'Friend' })))).ok, true);
    const saved = await state(host); assert.equal(saved.lines[0].start, line.start); assert.equal(saved.lines[0].end, line.end); assert.equal(saved.lines[0].caption, 'Allowed');
  });
  test('ordinary participant cannot toggle protection; an atomic timing batch never partially moves', async () => {
    const host = await scene(), guest = await join(host.room, 'Guest'), snapshot = await state(host);
    assert.equal((await ack(guest, 'set_protect_timings', { sessionId: snapshot.activeSessionId, enabled: true })).ok, false);
    await ack(host, 'set_protect_timings', { sessionId: snapshot.activeSessionId, enabled: true });
    const batch = snapshot.lines.slice(0, 2).map(line => patch(line, { start: line.start + .5, end: line.end + .5 }));
    assert.equal((await ack(guest, 'editor_update_lines', operation(snapshot, { updates: batch }))).reason, 'timingsProtected'); assert.deepEqual((await state(host)).lines, snapshot.lines);
    await ack(host, 'set_protect_timings', { sessionId: snapshot.activeSessionId, enabled: false });
    assert.equal((await ack(guest, 'editor_update_lines', operation(await state(host), { updates: batch }))).ok, true);
  });
  test('multiple moderators, duplicate grants, private identities and host-only grant/revoke', async () => {
    const host = await scene(), one = await join(host.room, 'One'), two = await join(host.room, 'Two'), guest = await join(host.room, 'Guest');
    const first = await grant(host, one); await grant(host, two); assert.equal((await ack(host, 'host_grant_moderator', { nick: 'One' })).changed, false);
    assert.equal((await ack(one, 'host_grant_moderator', { nick: 'Guest' })).ok, false);
    assert.equal((await ack(guest, 'host_grant_moderator', { nick: 'Guest', role: 'host', moderator: true })).ok, false);
    assert.equal((await ack(two, 'host_revoke_moderator', { id: first.id })).ok, false);
    assert.equal((await ack(host, 'host_grant_moderator', { nick: 'Host' })).ok, false);
    assert.equal((await ack(host, 'host_grant_moderator', { nick: 'Missing' })).ok, false);
    const snapshot = await state(guest); assert.equal(snapshot.moderators.length, 2); assert.equal(snapshot.host, 'Host');
    assert.equal(JSON.stringify(snapshot).includes(one.clientId), false); assert.equal(JSON.stringify(snapshot).includes(two.clientId), false);
    assert.equal((await ack(host, 'host_revoke_moderator', { id: first.id })).changed, true);
    assert.equal((await ack(host, 'host_revoke_moderator', { id: first.id })).changed, false);
  });
  test('revocation immediately rejects a delayed privileged action without revoking ordinary Edit rights', async () => {
    const host = await scene(), moderator = await join(host.room, 'Moderator'), record = await grant(host, moderator), snapshot = await state(host);
    await ack(host, 'host_revoke_moderator', { id: record.id });
    assert.equal((await ack(moderator, 'set_protect_timings', { sessionId: snapshot.activeSessionId, enabled: true })).ok, false);
    moderator.socket.emit('set_session_mode', { sessionId: snapshot.activeSessionId, mode: 'dub' }); await wait(30);
    assert.equal((await state(host)).mode, 'edit');
    assert.equal((await ack(moderator, 'editor_update_line', operation(snapshot, patch(snapshot.lines[0], { caption: 'Ordinary edit still works' })))).ok, true);
  });
  test('moderator survives nickname change and reconnect; offline grant can be revoked by opaque id', async () => {
    const host = await scene(), moderator = await join(host.room, 'Moderator'), record = await grant(host, moderator);
    moderator.socket.emit('rename_user', { newName: 'Renamed' }); await waitUntil(async () => (await state(host)).moderators[0].nick === 'Renamed');
    moderator.socket.disconnect(); await waitUntil(async () => !(await state(host)).moderators[0].online);
    const returned = await join(host.room, 'Renamed', moderator.clientId), snapshot = await state(host);
    assert.equal(snapshot.moderators[0].id, record.id); assert.equal(snapshot.moderators[0].online, true);
    assert.equal((await ack(returned, 'set_protect_timings', { sessionId: snapshot.activeSessionId, enabled: true })).ok, true);
    returned.socket.disconnect(); await waitUntil(async () => !(await state(host)).moderators[0].online);
    assert.equal((await ack(host, 'host_revoke_moderator', { id: record.id })).ok, true); assert.deepEqual((await state(host)).moderators, []);
  });
  test('moderator can manage Dub project mix, claims, Blind Mode, mode and pause but never Watch controller', async () => {
    const host = await scene('dub'), moderator = await join(host.room, 'Moderator'); await grant(host, moderator); const snapshot = await state(host), id = snapshot.activeSessionId;
    const project = await ack(moderator, 'project_audio_update', { sessionId: id, revision: snapshot.projectAudio.revision, channel: 'dub', field: 'volume', value: .7 });
    assert.equal(project.ok, true, JSON.stringify(project));
    moderator.socket.emit('set_blind_mode', { sessionId: id, enabled: true }); await waitUntil(async () => (await state(host)).blindMode === true);
    let pause; host.socket.once('force_pause', data => { pause = data; }); moderator.socket.emit('host_force_pause', { sessionId: id }); await waitUntil(() => !!pause); assert.equal(pause.by, 'Moderator');
    moderator.socket.emit('host_watch_start', { sessionId: id, position: 0 }); await wait(30); assert.equal((await state(host)).watch?.active, undefined);
    moderator.socket.emit('set_session_mode', { sessionId: id, mode: 'edit' }); await waitUntil(async () => (await state(host)).mode === 'edit');
  });
  test('reusing an offline moderator nickname on another device never transfers elevated permissions', async () => {
    const host = await scene(), moderator = await join(host.room, 'Moderator'), record = await grant(host, moderator);
    moderator.socket.disconnect(); await waitUntil(async () => !(await state(host)).moderators[0].online);
    const impostor = await join(host.room, 'Moderator'), snapshot = await state(host);
    assert.equal(snapshot.moderators[0].id, record.id); assert.equal(snapshot.moderators[0].online, false);
    assert.equal((await ack(impostor, 'set_protect_timings', { sessionId: snapshot.activeSessionId, enabled: true })).ok, false);
    await ack(host, 'host_revoke_moderator', { id: record.id }); assert.deepEqual((await state(host)).moderators, []);
  });
  for (const event of ['host_set_password', 'host_rename_session', 'host_delete_session', 'host_set_audio_tracks', 'host_kick', 'host_unban_all']) test(`moderator cannot run ${event}`, async () => {
    const host = await scene(), moderator = await join(host.room, 'Moderator'), guest = await join(host.room, 'Guest'); await grant(host, moderator); const initial = await state(host);
    moderator.socket.emit(event, { sessionId: initial.activeSessionId, id: initial.activeSessionId, title: 'Forbidden title', password: 'forbidden', original: -1, backing: -1, nick: 'Guest' }); await wait(30);
    const snapshot = await state(host); assert.equal(snapshot.title, initial.title); assert.equal(snapshot.activeSessionId, initial.activeSessionId); assert.equal(snapshot.hasPassword, initial.hasPassword); assert.equal(snapshot.originalTrack, initial.originalTrack); assert.equal(guest.socket.connected, true);
  });
  test('room grants and timing protection persist across restart without leaking into a portable project', async () => {
    const host = await scene(), moderator = await join(host.room, 'Moderator'); const record = await grant(host, moderator), id = (await state(host)).activeSessionId;
    await ack(host, 'set_protect_timings', { sessionId: id, enabled: true });
    await waitUntil(() => { try { return JSON.parse(fs.readFileSync(`${server.dirs.data}/rooms.json`, 'utf8'))[host.room]?.sessions[id]?.protectTimings === true; } catch { return false; } });
    const barrier = await ack(host, 'snapshot_request', { sessionId: id, purpose: 'project' });
    assert.equal(barrier.ok, true);
    for (const player of [host, moderator]) assert.equal((await ack(player, 'snapshot_ready', { token: barrier.token, sessionId: id, reason: 'ready' })).ok, true);
    const response = await fetch(`http://localhost:${server.port}/api/export-project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: host.room, clientId: host.clientId, sessionId: id, barrierToken: barrier.token }) });
    assert.equal(response.status, 200, await response.clone().text());
    const bytes = Buffer.from(await response.arrayBuffer()), parsed = require('./server/projects').readProject(bytes);
    assert.equal(parsed.manifest.project.protectTimings, true);
    for (const privateValue of [moderator.clientId, record.id, 'moderators']) assert.equal(JSON.stringify(parsed.manifest).includes(privateValue), false);
    const staged = require('./server/projects').stageProject(bytes, server.dirs.uploads);
    assert.equal(staged.fields.protectTimings, true); staged.rollback();
    await server.restart(); await waitUntil(() => host.socket.connected && moderator.socket.connected);
    await waitUntil(async () => (await state(host)).moderators.some(item => item.id === record.id && item.online));
    assert.equal((await state(host)).protectTimings, true);
    assert.equal((await ack(moderator, 'set_protect_timings', { sessionId: id, enabled: false })).ok, true);
    const form = new FormData(); form.append('clientId', host.clientId); form.append('sessionId', id); form.append('project', new Blob([bytes]), 'protected.dubline');
    const imported = await fetch(`http://localhost:${server.port}/api/import-project?room=${host.room}`, { method: 'POST', body: form });
    assert.equal(imported.status, 200, await imported.clone().text());
    const reopened = await state(host); assert.notEqual(reopened.activeSessionId, id); assert.equal(reopened.protectTimings, true); assert.equal(reopened.moderators[0].id, record.id);
  });
  test('transferring recorded tracks preserves authorship, audio placement and every mix setting under a claimed destination', async () => {
    const host = await scene('dub'), guest = await join(host.room, 'Guest');
    for (const id of [1, 3]) {
      const line = await upload(host, id), snapshot = await state(host);
      assert.equal((await ack(host, 'set_take_props', { sessionId: snapshot.activeSessionId, lineId: id, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision, volume: .4, pan: -.7, effect: 'radio', effectAmount: .3, pitch: 2, trimEnabled: false, audioStart: line.start - .25 })).ok, true);
    }
    const id = (await state(host)).activeSessionId; guest.socket.emit('claim_character', { sessionId: id, character: 'Friend' });
    await waitUntil(async () => (await state(host)).characterClaims.Friend === 'Guest');
    host.socket.emit('set_session_mode', { sessionId: id, mode: 'edit' }); await waitUntil(async () => (await state(host)).mode === 'edit');
    const initial = await state(host); assert.equal((await ack(host, 'editor_delete_track', operation(initial, deletion(initial, 'Hero', 'transfer', 'Friend')))).ok, true);
    const moved = await state(host); assert.equal(moved.characterClaims.Friend, 'Guest');
    for (const old of initial.lines.filter(line => line.character === 'Hero')) assert.deepEqual(moved.lines.find(line => line.id === old.id), { ...old, character: 'Friend', claimedBy: null, revision: old.revision + 1 });
    assert.equal((await ack(host, 'editor_undo', operation(moved))).undone, 2);
    assert.deepEqual((await state(host)).lines.map(({ revision, ...line }) => line), initial.lines.map(({ revision, ...line }) => line));
  });
  test('track trash keeps take files until explicit purge and restores takes with the original track', async () => {
    const host = await scene('dub'), take = await upload(host, 1), id = (await state(host)).activeSessionId;
    host.socket.emit('set_session_mode', { sessionId: id, mode: 'edit' }); await waitUntil(async () => (await state(host)).mode === 'edit');
    const snapshot = await state(host); await ack(host, 'editor_delete_track', operation(snapshot, deletion(snapshot, 'Hero')));
    assert.equal((await fetch(server.url(take.audioUrl))).status, 200);
    const result = await ack(host, 'editor_undo', operation(await state(host))); assert.equal(result.undone, 2);
    assert.equal((await state(host)).lines.find(line => line.id === 1).audioUrl, take.audioUrl);
  });
  test('moderators edit all foreign take parameters and atomic bulk mixes; revocation restores author/owner policy', async () => {
    const host = await scene('dub'), moderator = await join(host.room, 'Moderator'), guest = await join(host.room, 'Guest'); const grantRecord = await grant(host, moderator);
    await upload(host, 1); await upload(host, 3); const initial = await state(host);
    const takes = initial.lines.filter(line => line.audioUrl).map(line => ({ lineId: line.id, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision }));
    assert.equal((await ack(guest, 'set_takes_props', { sessionId: initial.activeSessionId, takes, props: { volume: .7 } })).reason, 'owner');
    assert.equal((await ack(moderator, 'set_takes_props', { sessionId: initial.activeSessionId, takes, props: { volume: .7, pan: -.2, effect: 'radio', effectAmount: .4, pitch: 2 } })).ok, true);
    const saved = await state(host); assert.ok(saved.lines.filter(line => line.audioUrl).every(line => line.volume === .7 && line.pan === -.2 && line.recordedBy === 'Host'));
    assert.equal((await ack(moderator, 'set_takes_props', { sessionId: initial.activeSessionId, takes, props: { volume: .2 } })).reason, 'conflict');
    assert.deepEqual((await state(host)).lines, saved.lines);
    const line = saved.lines[0]; assert.equal((await ack(moderator, 'set_needs_retake', { sessionId: initial.activeSessionId, lineId: line.id, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision, value: true })).ok, true);
    await ack(host, 'host_revoke_moderator', { id: grantRecord.id });
    const current = (await state(host)).lines[0];
    assert.equal((await ack(moderator, 'set_take_props', { sessionId: initial.activeSessionId, lineId: current.id, audioUrl: current.audioUrl, takeMixRevision: current.takeMixRevision, volume: .1 })).reason, 'owner');
    assert.equal((await ack(host, 'set_take_props', { sessionId: initial.activeSessionId, lineId: current.id, audioUrl: current.audioUrl, takeMixRevision: current.takeMixRevision, volume: .1 })).ok, true);
  });
  test('moderator grants never permit reserving another actor’s take or exporting/importing projects', async () => {
    const host = await scene('dub'), moderator = await join(host.room, 'Moderator'); await grant(host, moderator); await upload(host, 1); const snapshot = await state(host);
    assert.equal((await ack(moderator, 'reserve_take', { sessionId: snapshot.activeSessionId, lineId: 1 })).reason, 'owner');
    const response = await fetch(`http://localhost:${server.port}/api/export-project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: host.room, clientId: moderator.clientId, sessionId: snapshot.activeSessionId }) }); assert.equal(response.status, 403);
    const imported = await fetch(`http://localhost:${server.port}/api/load-server-pack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: host.room, clientId: moderator.clientId, filename: 'test-scene.zip' }) }); assert.equal(imported.status, 403); assert.equal((await state(host)).activeSessionId, snapshot.activeSessionId);
    const projectForm = new FormData(); projectForm.append('clientId', moderator.clientId); projectForm.append('sessionId', snapshot.activeSessionId); projectForm.append('project', new Blob(['invalid project']), 'attempt.dubline');
    assert.equal((await fetch(`http://localhost:${server.port}/api/import-project?room=${host.room}`, { method: 'POST', body: projectForm })).status, 403);
    const reserve = await ack(host, 'reserve_take', { sessionId: snapshot.activeSessionId, lineId: 1 });
    const audioForm = new FormData();
    for (const [key, value] of Object.entries({ clientId: moderator.clientId, userName: moderator.nick, sessionId: snapshot.activeSessionId, lineId: 1, takeSequence: reserve.takeSequence, uploadId: `forged-${++serial}`, audioStart: 0 })) audioForm.append(key, value);
    audioForm.append('audio', new Blob(['forged recording']), 'take.webm');
    assert.equal((await fetch(`http://localhost:${server.port}/api/upload-line-audio?room=${host.room}`, { method: 'POST', body: audioForm })).status, 403);
    assert.equal((await state(host)).lines[0].audioUrl, snapshot.lines[0].audioUrl);
  });
  test('grant requests require confirmed members of this room and cannot target a different room', async () => {
    const host = await scene(), elsewhere = await join('another-moderator-room', 'Elsewhere');
    assert.equal((await ack(host, 'host_grant_moderator', { nick: elsewhere.nick, room: elsewhere.room })).ok, false);
    const unconfirmed = io(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true }); sockets.push(unconfirmed); await new Promise(resolve => unconfirmed.once('connect', resolve));
    assert.equal((await ack({ socket: unconfirmed }, 'host_grant_moderator', { nick: 'Host' })).reason, 'room');
  });
  test('a kicked moderator loses the grant and unbanning does not regrant privileges', async () => {
    const host = await scene(), moderator = await join(host.room, 'Moderator'); await grant(host, moderator);
    host.socket.emit('host_kick', { nick: 'Moderator' }); await waitUntil(async () => !(await state(host)).moderators.length);
    host.socket.emit('host_unban_all'); await waitUntil(async () => (await state(host)).bannedCount === 0);
    const returned = await join(host.room, 'Moderator', moderator.clientId), snapshot = await state(host);
    assert.equal((await ack(returned, 'set_protect_timings', { sessionId: snapshot.activeSessionId, enabled: true })).ok, false);
  });
  test('scene switch preserves moderator grants while stale scene commands cannot touch the new scene', async () => {
    const host = await scene(), moderator = await join(host.room, 'Moderator'), record = await grant(host, moderator), old = await state(host);
    const response = await fetch(`http://localhost:${server.port}/api/load-server-pack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'test-scene.zip', clientId: host.clientId, room: host.room }) }); assert.equal(response.status, 200);
    const next = await state(host); assert.notEqual(next.activeSessionId, old.activeSessionId); assert.equal(next.moderators[0].id, record.id);
    moderator.socket.emit('host_switch_session', { id: old.activeSessionId, role: 'host', isHost: true }); await wait(50);
    assert.equal((await state(host)).activeSessionId, next.activeSessionId);
    assert.equal((await ack(moderator, 'set_protect_timings', { sessionId: old.activeSessionId, enabled: true })).reason, 'session'); assert.equal((await state(host)).protectTimings, false);
  });
  test('snapshot freeze applies equally to moderator process actions and host role management', async () => {
    const host = await scene(), moderator = await join(host.room, 'Moderator'), record = await grant(host, moderator), snapshot = await state(host);
    const barrier = await ack(host, 'snapshot_request', { sessionId: snapshot.activeSessionId, purpose: 'project' });
    for (const player of [host, moderator]) await ack(player, 'snapshot_ready', { token: barrier.token, sessionId: snapshot.activeSessionId, reason: 'ready' });
    assert.equal((await ack(moderator, 'set_protect_timings', { sessionId: snapshot.activeSessionId, enabled: true })).reason, 'snapshot');
    assert.equal((await ack(host, 'host_revoke_moderator', { id: record.id })).reason, 'snapshot');
    host.socket.emit('snapshot_cancel', { token: barrier.token }); await wait(30);
    assert.equal((await ack(host, 'host_revoke_moderator', { id: record.id })).ok, true);
  });
  test('moderator releases foreign claims, resets and randomizes casting with the actual actor in system messages', async () => {
    const host = await scene('dub'), moderator = await join(host.room, 'Moderator'), guest = await join(host.room, 'Guest'); await grant(host, moderator);
    const id = (await state(host)).activeSessionId, messages = []; host.socket.on('chat_message', message => messages.push(message));
    guest.socket.emit('claim_character', { sessionId: id, character: 'Hero' }); await waitUntil(async () => (await state(host)).characterClaims.Hero === 'Guest');
    moderator.socket.emit('unclaim_character', { sessionId: id, character: 'Hero' }); await waitUntil(async () => !(await state(host)).characterClaims.Hero);
    assert.equal(messages.find(message => message.key === 'system.roleReleasedBy')?.params.by, 'Moderator');
    assert.equal((await ack(guest, 'claim_line', { sessionId: id, lineId: 1 })).ok, true);
    moderator.socket.emit('unclaim_line', { sessionId: id, lineId: 1 }); await waitUntil(async () => !(await state(host)).lines[0].claimedBy);
    await waitUntil(() => messages.some(message => message.key === 'system.lineReleasedBy' && message.params.by === 'Moderator'));
    moderator.socket.emit('random_cast', { sessionId: id }); await waitUntil(async () => Object.keys((await state(host)).characterClaims).length === 2);
    await waitUntil(() => messages.some(message => message.key === 'system.randomCast' && message.params.nick === 'Moderator'));
    moderator.socket.emit('host_reset_claims', { sessionId: id }); await waitUntil(async () => !(await state(host)).lines.some(line => line.claimedBy));
    assert.deepEqual((await state(host)).characterClaims, {});
    await waitUntil(() => messages.some(message => message.key === 'system.claimsResetBy' && message.params.by === 'Moderator'));
  });
  test('two moderators edit concurrently, retain ordinary conflicts and cannot spoof host authority after revocation', async () => {
    const host = await scene(), one = await join(host.room, 'One'), two = await join(host.room, 'Two'); const grantOne = await grant(host, one); await grant(host, two);
    const snapshot = await state(host), first = snapshot.lines[0], second = snapshot.lines[1];
    const results = await Promise.all([ack(one, 'editor_update_line', operation(snapshot, patch(first, { caption: 'One edit' }))), ack(two, 'editor_update_line', operation(snapshot, patch(second, { caption: 'Two edit' })))]);
    assert.ok(results.every(result => result.ok));
    assert.equal((await ack(two, 'editor_update_line', operation(snapshot, patch(first, { caption: 'Stale overwrite' })))).reason, 'conflict');
    assert.equal((await ack(one, 'editor_undo', operation(await state(host)))).undone, 1);
    assert.equal((await state(host)).lines[1].caption, 'Two edit');
    await ack(host, 'host_revoke_moderator', { id: grantOne.id });
    assert.equal((await ack(one, 'set_protect_timings', { sessionId: snapshot.activeSessionId, enabled: true, role: 'host', isModerator: true })).ok, false);
    assert.equal((await ack(two, 'set_protect_timings', { sessionId: snapshot.activeSessionId, enabled: true })).ok, true);
  });
});
