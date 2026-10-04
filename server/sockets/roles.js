// Roles and lines: claim/release, line characters, take settings, recording status
const { VOICE_EFFECTS, MAX_PITCH, MAX_TAKE_SHIFT } = require('../config');
const { recordingNow } = require('../state');
const { io } = require('../app');
const { sanitizeChatText } = require('../sanitize');
const { logEvent } = require('../log');
const { parseSeconds } = require('../parsers');
const { saveRooms, flushRooms, getRoom, emitSession, dropEmptyRoleClaims, snapshotActive } = require('../rooms');
const { broadcastRecording, addSystemMessage } = require('../presence');
const { isHost, getLineOwner } = require('../auth');
const history = require('../editHistory');

module.exports = function registerRoleHandlers(socket, conn) {
  // Allocate order before recording starts, not when its asynchronous processing finishes.
  socket.on('reserve_take', ({ lineId, sessionId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!conn.roomId || !conn.nick) return ack({ ok: false, reason: 'nick' });
    const room = getRoom(conn.roomId);
    snapshotActive(room);
    const target = sessionId === room.activeSessionId ? room : room.sessions[sessionId];
    const line = target && target.lines.find(item => item.id === lineId);
    if (!line || getLineOwner(target, line) !== conn.nick) return ack({ ok: false, reason: 'owner' });
    if (target.mode === 'edit') return ack({ ok: false, reason: 'mode' });
    line.takeCounter = Math.max(Number(line.takeCounter) || 0, Number(line.takeSequence) || 0) + 1;
    flushRooms();
    ack({ ok: true, takeSequence: line.takeCounter });
  });

  socket.on('claim_character', ({ character } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    if (room.characterClaims[character]) return;

    room.characterClaims[character] = conn.nick;
    room.lines.forEach(l => {
      if (l.character === character) l.claimedBy = conn.nick;
    });
    saveRooms();
    emitSession(conn.roomId);
  });

  // A role can be released by its owner or the host
  socket.on('unclaim_character', ({ character } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    const owner = room.characterClaims[character];
    if (!owner || (owner !== conn.nick && !isHost(room, conn.clientId))) return;

    delete room.characterClaims[character];
    room.lines.forEach(l => {
      if (l.character === character && l.claimedBy === owner) l.claimedBy = null;
    });
    saveRooms();
    emitSession(conn.roomId);
    if (owner !== conn.nick) addSystemMessage(conn.roomId, 'system.roleReleased', { character, owner }, `👑 The host released the role "${character}" from ${owner}`);
  });

  socket.on('claim_line', ({ lineId } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    const line = room.lines.find(l => l.id === lineId);
    if (!line) return;

    const charOwner = room.characterClaims[line.character];
    if (charOwner && charOwner !== conn.nick) return;
    if (!line.claimedBy || line.claimedBy === conn.nick) {
      line.claimedBy = conn.nick;
      saveRooms();
      io.to(conn.roomId).emit('line_updated', line);
    }
  });

  socket.on('unclaim_line', ({ lineId } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    const line = room.lines.find(l => l.id === lineId);
    if (!line || !line.claimedBy) return;
    if (room.characterClaims[line.character]) return;

    const owner = line.claimedBy;
    if (owner !== conn.nick && !isHost(room, conn.clientId)) return;

    line.claimedBy = null;
    saveRooms();
    io.to(conn.roomId).emit('line_updated', line);
    if (owner !== conn.nick) addSystemMessage(conn.roomId, 'system.lineReleased', { id: line.id, owner }, `👑 The host released line #${line.id} from ${owner}`);
  });

  // Settings of your own take: effect, pitch, silence trimming, manual shift on the timeline
  socket.on('set_take_props', (data = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    const line = room.lines.find(l => l.id === data.lineId);
    if (!line || getLineOwner(room, line) !== conn.nick) return;
    if (data.sessionId !== room.activeSessionId || data.audioUrl !== line.audioUrl) return;

    if (VOICE_EFFECTS.includes(data.effect)) line.effect = data.effect;
    if (data.pitch !== undefined) {
      const pitch = Math.round(Number(data.pitch));
      if (Number.isFinite(pitch)) line.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
    }
    if (typeof data.trimEnabled === 'boolean') line.trimEnabled = data.trimEnabled;
    if (data.audioStart !== undefined && line.audioUrl) {
      const start = parseSeconds(data.audioStart);
      if (start !== null) {
        const min = Math.max(-5, line.start - MAX_TAKE_SHIFT);
        line.audioStart = Number(Math.max(min, Math.min(line.start + MAX_TAKE_SHIFT, start)).toFixed(3));
      }
    }

    saveRooms();
    io.to(conn.roomId).emit('line_updated', line);
  });

  socket.on('host_reset_claims', () => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId)) return;

    room.characterClaims = Object.create(null);
    room.lines.forEach(l => { l.claimedBy = null; });
    saveRooms();
    emitSession(conn.roomId);
    addSystemMessage(conn.roomId, 'system.claimsReset', {}, '♻️ The host released all roles and lines (recorded takes are kept)');
  });

  // ---------- Line characters: moving lines to another track ----------
  // `before` collects the lines' previous state for undo (Ctrl+Z in Edit Mode)
  function moveLine(room, line, name, before) {
    const oldName = line.character;
    if (oldName === name) return false;
    before.set(line.id, history.lineBefore(line));
    // The line now belongs to the new role (and whoever claimed it), not to the old owner
    line.claimedBy = null;
    line.character = name;
    line.revision = Number(line.revision || 0) + 1;
    return true;
  }

  function cleanCharacterName(raw) {
    return sanitizeChatText(raw).slice(0, 40);
  }

  socket.on('set_line_character', ({ lineId, revision, character, sessionId } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!conn.roomId || !conn.nick) return reply({ ok: false, reason: 'room' });
    const room = getRoom(conn.roomId);
    if (room.mode !== 'edit') return reply({ ok: false, reason: 'mode' });
    if (sessionId !== undefined && sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    const line = room.lines.find(l => l.id === lineId);
    const name = cleanCharacterName(character);
    if (!line) return reply({ ok: false, reason: 'missing' });
    if (Number(revision) !== Number(line.revision || 0)) return reply({ ok: false, reason: 'conflict', line });
    if (!name) return reply({ ok: false, reason: 'invalid' });
    const oldName = line.character;
    const before = new Map();
    const claimsBefore = { ...room.characterClaims };
    if (!Array.isArray(room.trackOrder)) room.trackOrder = [];
    const trackOrderBefore = [...room.trackOrder];
    if (!moveLine(room, line, name, before)) return reply({ ok: true, moved: 0, line });
    if (!room.trackOrder.includes(name)) room.trackOrder.push(name);
    dropEmptyRoleClaims(room);
    history.recordLines(conn.roomId, room, conn.clientId, before, claimsBefore, trackOrderBefore);
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `✎ ${conn.nick}: line #${line.id}: "${oldName}" → "${name}"`);
    reply({ ok: true, moved: 1, line });
  });

  // Several selected lines at once. Revisions make the operation atomic.
  socket.on('set_lines_character', ({ lines, character, sessionId } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!conn.roomId || !conn.nick || !Array.isArray(lines) || !lines.length || lines.length > 2000) {
      return reply({ ok: false, reason: 'invalid', moved: 0, skipped: 0 });
    }
    const room = getRoom(conn.roomId);
    if (room.mode !== 'edit') return reply({ ok: false, reason: 'mode', moved: 0, skipped: lines.length });
    if (sessionId !== undefined && sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    const name = cleanCharacterName(character);
    if (!name) return reply({ ok: false, reason: 'invalid', moved: 0, skipped: lines.length });
    const expected = new Map();
    for (const item of lines) {
      const id = Number(item && item.lineId);
      if (!Number.isFinite(id) || expected.has(id) || !Number.isFinite(Number(item.revision))) {
        return reply({ ok: false, reason: 'invalid', moved: 0, skipped: lines.length });
      }
      expected.set(id, Number(item.revision));
    }
    const selected = [];
    for (const [id, revision] of expected) {
      const line = room.lines.find(item => item.id === id);
      if (!line) return reply({ ok: false, reason: 'missing', moved: 0, skipped: lines.length });
      selected.push(line);
    }
    const conflicts = selected.filter(line => expected.get(line.id) !== Number(line.revision || 0));
    if (conflicts.length) return reply({ ok: false, reason: 'conflict', moved: 0, skipped: lines.length, lines: conflicts });

    let moved = 0;
    const before = new Map();
    const claimsBefore = { ...room.characterClaims };
    if (!Array.isArray(room.trackOrder)) room.trackOrder = [];
    const trackOrderBefore = [...room.trackOrder];
    selected.forEach(line => { if (moveLine(room, line, name, before)) moved++; });
    if (moved) {
      if (!room.trackOrder.includes(name)) room.trackOrder.push(name);
      dropEmptyRoleClaims(room);
      history.recordLines(conn.roomId, room, conn.clientId, before, claimsBefore, trackOrderBefore);
      saveRooms();
      emitSession(conn.roomId);
      logEvent(conn.roomId, `✎ ${conn.nick}: ${moved} lines → "${name}"`);
    }
    reply({ ok: true, moved, skipped: 0, lines: selected });
  });

  // Rename a whole track (all of a character's lines); an existing name means a merge
  socket.on('rename_character', ({ from, to, lines: expectedLines, sessionId } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!conn.roomId || !conn.nick) return reply({ ok: false });
    const room = getRoom(conn.roomId);
    if (room.mode !== 'edit') return reply({ ok: false, reason: 'mode' });
    if (sessionId !== undefined && sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    if (!Array.isArray(room.trackOrder)) room.trackOrder = [];
    const hasTrack = room.trackOrder.includes(from);
    const name = cleanCharacterName(to);
    const lines = room.lines.filter(l => l.character === from);
    if (!name || (!lines.length && !hasTrack) || name === from || !Array.isArray(expectedLines)) {
      return reply({ ok: false, reason: 'invalid' });
    }
    const expected = new Map();
    for (const item of expectedLines) {
      const id = Number(item && item.lineId);
      if (!Number.isFinite(id) || expected.has(id) || !Number.isFinite(Number(item.revision))) {
        return reply({ ok: false, reason: 'invalid' });
      }
      expected.set(id, Number(item.revision));
    }
    const staleSet = expected.size !== lines.length || lines.some(line => !expected.has(line.id));
    const conflicts = lines.filter(line => expected.get(line.id) !== Number(line.revision || 0));
    if (staleSet || conflicts.length) return reply({ ok: false, reason: 'conflict', lines });
    const roleOwner = room.characterClaims[from];
    const before = new Map(lines.map(line => [line.id, history.lineBefore(line)]));
    const claimsBefore = { ...room.characterClaims };
    const trackOrderBefore = [...room.trackOrder];
    lines.forEach(line => {
      line.character = name;
      line.revision = Number(line.revision || 0) + 1;
    });
    room.trackOrder = [...new Set(room.trackOrder.map(track => track === from ? name : track))];
    // A claimed role moves with the track if the new name is free
    if (roleOwner && !room.characterClaims[name]) room.characterClaims[name] = roleOwner;
    delete room.characterClaims[from];
    if (roleOwner && room.characterClaims[name] !== roleOwner) lines.forEach(line => { if (!line.claimedBy) line.claimedBy = roleOwner; });
    dropEmptyRoleClaims(room);
    history.recordLines(conn.roomId, room, conn.clientId, before, claimsBefore, trackOrderBefore);
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `✎ ${conn.nick}: track "${from}" → "${name}" (${lines.length} lines)`);
    reply({ ok: true, moved: lines.length, lines });
  });

  // The host releases selected lines someone claimed by mistake
  socket.on('host_release_lines', ({ lineIds } = {}) => {
    if (!conn.roomId || !Array.isArray(lineIds)) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId)) return;
    let released = 0;
    for (const id of lineIds) {
      const line = room.lines.find(l => l.id === id);
      if (line && line.claimedBy && !room.characterClaims[line.character]) {
        line.claimedBy = null;
        released++;
      }
    }
    if (!released) return;
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `👑 ${conn.nick} released lines: ${released}`);
  });

  // ---------- Recording status ----------
  socket.on('recording_status', ({ lineId, recording } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    if (room.mode === 'edit') return;
    const line = room.lines.find(l => l.id === lineId);
    if (!line) return;
    const map = recordingNow[conn.roomId] || (recordingNow[conn.roomId] = {});

    if (recording) {
      if (getLineOwner(room, line) !== conn.nick) return;
      map[lineId] = { nick: conn.nick, socketId: socket.id };
      logEvent(conn.roomId, `🔴 ${conn.nick} is recording line #${lineId}`);
    } else if (map[lineId] && map[lineId].socketId === socket.id) {
      delete map[lineId];
    } else {
      return;
    }
    broadcastRecording(conn.roomId);
  });
};
