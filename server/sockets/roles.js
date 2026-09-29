// Roles and lines: claim/release, line characters, take settings, recording status
const { VOICE_EFFECTS, MAX_PITCH, MAX_TAKE_SHIFT } = require('../config');
const { recordingNow } = require('../state');
const { io } = require('../app');
const { sanitizeChatText } = require('../sanitize');
const { logEvent } = require('../log');
const { parseSeconds } = require('../parsers');
const { saveRooms, getRoom, emitSession, dropEmptyRoleClaims } = require('../rooms');
const { broadcastRecording, addSystemMessage } = require('../presence');
const { isHost, getLineOwner } = require('../auth');

module.exports = function registerRoleHandlers(socket, conn) {
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

    if (VOICE_EFFECTS.includes(data.effect)) line.effect = data.effect;
    if (data.pitch !== undefined) {
      const pitch = Math.round(Number(data.pitch));
      if (Number.isFinite(pitch)) line.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
    }
    if (typeof data.trimEnabled === 'boolean') line.trimEnabled = data.trimEnabled;
    if (data.audioStart !== undefined && line.audioUrl) {
      const start = parseSeconds(data.audioStart);
      if (start !== null) {
        const min = Math.max(0, line.start - MAX_TAKE_SHIFT);
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

    room.characterClaims = {};
    room.lines.forEach(l => { l.claimedBy = null; });
    saveRooms();
    emitSession(conn.roomId);
    addSystemMessage(conn.roomId, 'system.claimsReset', {}, '♻️ The host released all roles and lines (recorded takes are kept)');
  });

  // ---------- Line characters: moving lines to another track ----------
  // Everyone can move their own and free lines; the host can move any, including into others' roles
  function canMoveLine(room, line, name, host) {
    if (host) return true;
    const owner = getLineOwner(room, line);
    if (owner && owner !== conn.nick) return false;
    const roleOwner = room.characterClaims[name];
    return !roleOwner || roleOwner === conn.nick;
  }

  function moveLine(room, line, name) {
    const oldName = line.character;
    if (oldName === name) return false;
    // If the line belonged to a player through a role, keep the owner explicitly
    if (!line.claimedBy && room.characterClaims[oldName]) line.claimedBy = room.characterClaims[oldName];
    line.character = name;
    return true;
  }

  function cleanCharacterName(raw) {
    return sanitizeChatText(raw).slice(0, 40);
  }

  socket.on('set_line_character', ({ lineId, character } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    const line = room.lines.find(l => l.id === lineId);
    const name = cleanCharacterName(character);
    if (!line || !name || !canMoveLine(room, line, name, isHost(room, conn.clientId))) return;
    const oldName = line.character;
    if (!moveLine(room, line, name)) return;
    dropEmptyRoleClaims(room);
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `✎ ${conn.nick}: line #${line.id}: "${oldName}" → "${name}"`);
  });

  // Several selected lines at once; unavailable ones are skipped and counted
  socket.on('set_lines_character', ({ lineIds, character } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!conn.roomId || !conn.nick || !Array.isArray(lineIds)) return reply({ moved: 0, skipped: 0 });
    const room = getRoom(conn.roomId);
    const name = cleanCharacterName(character);
    if (!name) return reply({ moved: 0, skipped: lineIds.length });
    const host = isHost(room, conn.clientId);
    let moved = 0;
    let skipped = 0;
    for (const id of lineIds.slice(0, 2000)) {
      const line = room.lines.find(l => l.id === id);
      if (!line) continue;
      if (!canMoveLine(room, line, name, host)) { skipped++; continue; }
      if (moveLine(room, line, name)) moved++;
    }
    if (moved) {
      dropEmptyRoleClaims(room);
      saveRooms();
      emitSession(conn.roomId);
      logEvent(conn.roomId, `✎ ${conn.nick}: ${moved} lines → "${name}"${skipped ? ` (skipped ${skipped})` : ''}`);
    }
    reply({ moved, skipped });
  });

  // Rename a whole track (all of a character's lines); an existing name means a merge
  socket.on('rename_character', ({ from, to } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!conn.roomId || !conn.nick) return reply({ ok: false });
    const room = getRoom(conn.roomId);
    const name = cleanCharacterName(to);
    const lines = room.lines.filter(l => l.character === from);
    if (!name || !lines.length || name === from) return reply({ ok: false });
    const host = isHost(room, conn.clientId);
    if (!host && !lines.every(line => canMoveLine(room, line, name, false))) return reply({ ok: false, reason: 'denied' });

    const roleOwner = room.characterClaims[from];
    lines.forEach(line => { line.character = name; });
    // A claimed role moves with the track if the new name is free
    if (roleOwner && !room.characterClaims[name]) room.characterClaims[name] = roleOwner;
    delete room.characterClaims[from];
    if (roleOwner && room.characterClaims[name] !== roleOwner) lines.forEach(line => { if (!line.claimedBy) line.claimedBy = roleOwner; });
    dropEmptyRoleClaims(room);
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `✎ ${conn.nick}: track "${from}" → "${name}" (${lines.length} lines)`);
    reply({ ok: true, moved: lines.length });
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
