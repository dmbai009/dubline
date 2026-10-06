const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startServer, waitUntil, wait } = require('./e2e/helpers');

describe('Editor operation protocol and semantic history', () => {
  let server, serial = 0;
  const sockets = [];
  before(async () => { server = await startServer(); });
  after(async () => { sockets.forEach(socket => socket.disconnect()); await server?.cleanup(); });
  const ack = (player, event, data = {}) => new Promise((resolve, reject) => player.socket.timeout(5000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
  const state = async player => (await ack(player, 'editor_resync')).session;
  async function join(room, nick, clientId = `${nick}-${++serial}`) {
    const socket = io(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    const player = { socket, room, nick, clientId, presence: null };
    socket.on('selection_presence', data => { player.presence = data; });
    await new Promise((resolve, reject) => {
      socket.once('connect_error', reject);
      socket.on('connect', () => socket.emit('join_room', { room, nick, clientId }));
      socket.once('nick_state', data => data.nick === nick ? resolve() : reject(new Error(JSON.stringify(data))));
    });
    return player;
  }
  async function scene() {
    const alice = await join(`hardening-unit-${++serial}`, 'Alice');
    const response = await fetch(`http://localhost:${server.port}/api/load-server-pack?room=${alice.room}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'test-scene.zip', clientId: alice.clientId, room: alice.room })
    });
    assert.equal(response.status, 200);
    alice.socket.emit('set_session_mode', { mode: 'edit' });
    await waitUntil(async () => (await state(alice)).mode === 'edit');
    return alice;
  }
  function operation(snapshot, payload = {}) {
    return { ...payload, sessionId: snapshot.activeSessionId, operationId: `test-${++serial}`,
      operationEpoch: snapshot.editorProtocol.epoch, operationTime: snapshot.editorProtocol.serverTime };
  }
  function patch(line, changes) {
    return { lineId: line.id, revision: line.revision || 0, base: { caption: line.caption, start: line.start, end: line.end, character: line.character }, ...changes };
  }

  for (const event of ['editor_create_line', 'editor_update_line', 'editor_update_lines', 'editor_delete_lines', 'editor_add_track', 'editor_undo', 'set_line_character', 'set_lines_character', 'rename_character']) {
    test(`${event} duplicate returns its frozen receipt without mutation or extra Undo`, async () => {
      const alice = await scene();
      let snapshot = await state(alice);
      if (event === 'editor_undo') {
        await ack(alice, 'editor_update_line', operation(snapshot, patch(snapshot.lines[0], { caption: 'Undo me' })));
        snapshot = await state(alice);
      }
      const lines = snapshot.lines.slice(0, 2);
      const payloads = {
        editor_create_line: { character: 'Hero', caption: 'Created once', start: 0, end: 1 },
        editor_update_line: patch(lines[0], { caption: 'Saved once' }),
        editor_update_lines: { updates: lines.map(line => patch(line, { caption: 'Batch once' })) },
        editor_delete_lines: { lines: lines.map(line => ({ lineId: line.id, revision: line.revision || 0 })) },
        editor_add_track: { character: 'New track' }, editor_undo: {},
        set_line_character: { lineId: lines[0].id, revision: lines[0].revision || 0, character: 'New role' },
        set_lines_character: { lines: lines.map(line => ({ lineId: line.id, revision: line.revision || 0 })), character: 'New role' },
        rename_character: { from: 'Hero', to: 'Renamed', lines: snapshot.lines.filter(line => line.character === 'Hero').map(line => ({ lineId: line.id, revision: line.revision || 0 })) }
      };
      const request = operation(snapshot, payloads[event]);
      const first = await ack(alice, event, request);
      assert.equal(first.ok, true, JSON.stringify(first));
      const saved = await state(alice);
      assert.deepEqual(await ack(alice, event, request), first);
      const duplicate = await state(alice);
      assert.deepEqual(duplicate.lines, saved.lines);
      assert.deepEqual(duplicate.trackOrder, saved.trackOrder);
      if (event !== 'editor_undo') {
        assert.equal((await ack(alice, 'editor_undo', operation(duplicate))).ok, true);
        assert.equal((await ack(alice, 'editor_undo', operation(await state(alice)))).reason, 'empty');
      }
    });
  }

  test('receipt binds payload, actor, room, session and survives nickname/reconnect', async () => {
    const alice = await scene(), snapshot = await state(alice);
    const request = operation(snapshot, { character: 'Receipt track' });
    const first = await ack(alice, 'editor_add_track', request);
    assert.equal((await ack(alice, 'editor_add_track', { ...request, character: 'Different' })).reason, 'operation');
    const bob = await join(alice.room, 'Bob');
    assert.equal((await ack(bob, 'editor_add_track', request)).reason, 'exists');
    alice.socket.emit('rename_user', { newName: 'Alicia' });
    await waitUntil(async () => (await state(alice)).host === 'Alicia');
    assert.deepEqual(await ack(alice, 'editor_add_track', request), first);
    alice.socket.disconnect();
    const returned = await join(alice.room, 'Alicia', alice.clientId);
    assert.deepEqual(await ack(returned, 'editor_add_track', request), first);
    assert.equal((await ack(returned, 'editor_add_track', { ...request, sessionId: 'old-scene' })).reason, 'session');
    const expired = operation(await state(returned), { character: 'Expired' }); expired.operationTime -= 31 * 60 * 1000;
    assert.equal((await ack(returned, 'editor_add_track', expired)).reason, 'expired');
    const otherEpoch = { ...expired, operationId: `test-${++serial}`, operationTime: Date.now(), operationEpoch: 'previous-server' };
    assert.equal((await ack(returned, 'editor_add_track', otherEpoch)).reason, 'expired');
  });

  test('caption and timing safely rebase; conflicting timing edge rejects entire group', async () => {
    const alice = await scene(), bob = await join(alice.room, 'Bob');
    const initial = await state(alice), line = initial.lines[0];
    assert.equal((await ack(alice, 'editor_update_line', operation(initial, patch(line, { caption: 'A caption' })))).ok, true);
    assert.equal((await ack(bob, 'editor_update_line', operation(initial, patch(line, { start: 3.2, end: 4.7 })))).ok, true);
    const merged = await state(alice);
    assert.equal(merged.lines[0].caption, 'A caption'); assert.equal(merged.lines[0].start, 3.2);
    const conflict = await ack(alice, 'editor_update_lines', operation(initial, { updates: [patch(line, { end: 4.8 }), patch(initial.lines[1], { caption: 'Must not apply' })] }));
    assert.equal(conflict.reason, 'conflict');
    assert.deepEqual((await state(alice)).lines, merged.lines);
    assert.equal((await ack(bob, 'editor_update_line', operation(initial, patch(line, { character: 'Friend' })))).reason, 'conflict');
  });

  test('Undo restores caption across another actor timing, refuses same-field ABA and group partial Undo', async () => {
    const alice = await scene(), bob = await join(alice.room, 'Bob');
    let snapshot = await state(alice);
    await ack(alice, 'editor_update_line', operation(snapshot, patch(snapshot.lines[0], { caption: 'Alice caption' })));
    snapshot = await state(bob);
    await ack(bob, 'editor_update_line', operation(snapshot, patch(snapshot.lines[0], { start: 3.3, end: 4.8 })));
    assert.equal((await ack(alice, 'editor_undo', operation(await state(alice)))).undone, 1);
    snapshot = await state(alice);
    assert.equal(snapshot.lines[0].caption, 'Hello there'); assert.equal(snapshot.lines[0].start, 3.3);
    await ack(alice, 'editor_update_lines', operation(snapshot, { updates: snapshot.lines.slice(0, 2).map(line => patch(line, { caption: 'Group' })) }));
    for (const caption of ['Bob caption', 'Group']) {
      snapshot = await state(bob);
      await ack(bob, 'editor_update_line', operation(snapshot, patch(snapshot.lines[0], { caption })));
    }
    const before = await state(alice);
    const result = await ack(alice, 'editor_undo', operation(before));
    assert.equal(result.undone, 0); assert.equal(result.skipped, 2);
    assert.deepEqual((await state(alice)).lines, before.lines);
  });

  test('selection identity is server-owned, late join receives snapshot, disconnect clears it and persistence excludes it', async () => {
    const alice = await scene(), bob = await join(alice.room, 'Bob'), snapshot = await state(alice);
    alice.socket.emit('selection_update', { sessionId: snapshot.activeSessionId, lineIds: [1, 2, 999], nick: 'Impersonated' });
    await waitUntil(() => bob.presence?.selections.some(entry => entry.nick === 'Alice' && entry.lineIds.length === 2));
    const charlie = await join(alice.room, 'Charlie');
    await waitUntil(() => charlie.presence?.selections.length === 1);
    assert.equal(charlie.presence.selections[0].nick, 'Alice');
    bob.socket.emit('selection_update', { sessionId: snapshot.activeSessionId, lineIds: [1] });
    await waitUntil(() => charlie.presence?.selections.length === 2);
    alice.socket.disconnect();
    await waitUntil(() => charlie.presence?.selections.length === 1 && charlie.presence.selections[0].nick === 'Bob');
    bob.socket.emit('selection_update', { sessionId: snapshot.activeSessionId, lineIds: [] });
    await waitUntil(() => !charlie.presence.selections.length);
    await wait(1500);
    const persisted = JSON.parse(fs.readFileSync(path.join(server.dirs.data, 'rooms.json'), 'utf8'))[alice.room];
    assert.equal(persisted.selectionPresence, undefined); assert.equal(persisted.editorProtocol, undefined);
    assert.ok(!JSON.stringify(persisted).includes('actorId'));
  });

  test('confirmed claim is scene-bound, atomic under two actor race, and preserves take authors', async () => {
    const alice = await scene(), bob = await join(alice.room, 'Bob');
    alice.socket.emit('set_session_mode', { mode: 'dub' });
    await waitUntil(async () => (await state(alice)).mode === 'dub');
    const snapshot = await state(alice);
    const data = { lineId: 1, sessionId: snapshot.activeSessionId };
    assert.equal((await ack(bob, 'claim_line', { ...data, sessionId: 'old' })).reason, 'session');
    const results = await Promise.all([ack(alice, 'claim_line', data), ack(bob, 'claim_line', data)]);
    assert.equal(results.filter(result => result.ok).length, 1);
    const claimed = (await state(alice)).lines[0];
    assert.equal(claimed.recordedBy, snapshot.lines[0].recordedBy);
    assert.equal(claimed.audioUrl, snapshot.lines[0].audioUrl);
    assert.equal((await ack(bob, 'reserve_take', { ...data })).ok, claimed.claimedBy === 'Bob');
  });
});
