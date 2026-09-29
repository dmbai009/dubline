// Роли и реплики: занять/освободить, персонажи реплик, настройки дубля, статус записи
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

  // Снять роль может ее владелец или хост
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
    if (owner !== conn.nick) addSystemMessage(conn.roomId, 'system.roleReleased', { character, owner }, `👑 Хост снял роль «${character}» с игрока ${owner}`);
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
    if (owner !== conn.nick) addSystemMessage(conn.roomId, 'system.lineReleased', { id: line.id, owner }, `👑 Хост освободил реплику #${line.id} игрока ${owner}`);
  });

  // Настройки своего дубля: эффект, питч, обрезка тишины, ручной сдвиг по таймлайну
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
    addSystemMessage(conn.roomId, 'system.claimsReset', {}, '♻️ Хост сбросил все роли и реплики (записанные дубли сохранены)');
  });

  // ---------- Персонажи реплик: перенос на другую дорожку ----------
  // Все могут переносить свои и свободные реплики; хост — любые, в том числе в чужие роли
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
    // Если реплика принадлежала игроку через роль, сохраняем владельца явно
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
    logEvent(conn.roomId, `✎ ${conn.nick}: реплика #${line.id} — «${oldName}» → «${name}»`);
  });

  // Несколько выделенных реплик разом; недоступные пропускаем и сообщаем сколько
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
      logEvent(conn.roomId, `✎ ${conn.nick}: ${moved} реплик → «${name}»${skipped ? ` (пропущено ${skipped})` : ''}`);
    }
    reply({ moved, skipped });
  });

  // Переименовать дорожку целиком (все реплики персонажа); с существующим именем — слияние
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
    // Занятая роль переезжает вместе с дорожкой, если новое имя свободно
    if (roleOwner && !room.characterClaims[name]) room.characterClaims[name] = roleOwner;
    delete room.characterClaims[from];
    if (roleOwner && room.characterClaims[name] !== roleOwner) lines.forEach(line => { if (!line.claimedBy) line.claimedBy = roleOwner; });
    dropEmptyRoleClaims(room);
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `✎ ${conn.nick}: дорожка «${from}» → «${name}» (${lines.length} реплик)`);
    reply({ ok: true, moved: lines.length });
  });

  // Хост освобождает выбранные реплики, которые кто-то занял по ошибке
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
    logEvent(conn.roomId, `👑 ${conn.nick} освободил реплик: ${released}`);
  });

  // ---------- Статус записи ----------
  socket.on('recording_status', ({ lineId, recording } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    const line = room.lines.find(l => l.id === lineId);
    if (!line) return;
    const map = recordingNow[conn.roomId] || (recordingNow[conn.roomId] = {});

    if (recording) {
      if (getLineOwner(room, line) !== conn.nick) return;
      map[lineId] = { nick: conn.nick, socketId: socket.id };
      logEvent(conn.roomId, `🔴 ${conn.nick} записывает реплику #${lineId}`);
    } else if (map[lineId] && map[lineId].socketId === socket.id) {
      delete map[lineId];
    } else {
      return;
    }
    broadcastRecording(conn.roomId);
  });
};
