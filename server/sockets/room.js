// Вход в комнату, ник, права хоста для вернувшегося, чат, задержка микрофона, часы
const { CHAT_RATE_LIMIT, MAX_LATENCY_MS } = require('../config');
const { roomSockets, watchState } = require('../state');
const { io } = require('../app');
const { sanitizeRoomId, sanitizeNick, sanitizeChatText } = require('../sanitize');
const { DISCONNECT_REASONS, logEvent } = require('../log');
const { saveRooms, getRoom, publicRoom, emitSession, ensureAudioTracks } = require('../rooms');
const { onlineCount, endWatch, recordingList, broadcastRecording, clearSocketSeeds, seedersSummary, broadcastSeeders, clearSocketRecordings, isHostOnline, broadcastRoomUsers, addChatMessage, addSystemMessage } = require('../presence');
const { isNickFree, takeOverNick, MAX_PASSWORD_ATTEMPTS, checkRoomPassword, isHost } = require('../auth');

module.exports = function registerRoomHandlers(socket, conn) {
  let chatTimestamps = [];
  let passwordAttempts = 0;

  function leaveCurrentRoom(reason) {
    if (conn.roomId && roomSockets[conn.roomId] && roomSockets[conn.roomId][socket.id]) {
      const room = getRoom(conn.roomId);
      const wasHost = isHost(room, conn.clientId);
      delete roomSockets[conn.roomId][socket.id];
      socket.leave(conn.roomId);
      if (clearSocketRecordings(conn.roomId, socket.id)) broadcastRecording(conn.roomId);
      if (clearSocketSeeds(conn.roomId, socket.id)) broadcastSeeders(conn.roomId);
      broadcastRoomUsers(conn.roomId);

      const why = typeof reason === 'string' ? ` — ${DISCONNECT_REASONS[reason] || reason}` : '';
      logEvent(conn.roomId, `← ${conn.nick || 'игрок без ника'} вышел${why}. Онлайн: ${onlineCount(conn.roomId)}`, reason === 'ping timeout' || reason === 'transport error' ? 'warn' : 'info');

      // Хост ушел совсем — совместный просмотр заканчивается
      if (wasHost && !isHostOnline(conn.roomId)) endWatch(conn.roomId, conn.nick, '🎬 Совместный просмотр остановлен: хост вышел');
    }
  }

  function renameClaims(room, oldName, newName) {
    for (const char in room.characterClaims) {
      if (room.characterClaims[char] === oldName) room.characterClaims[char] = newName;
    }
    room.lines.forEach(l => {
      if (l.claimedBy === oldName) l.claimedBy = newName;
      if (l.recordedBy === oldName) l.recordedBy = newName;
    });
    if (room.latency[oldName] !== undefined && room.latency[newName] === undefined) {
      room.latency[newName] = room.latency[oldName];
      delete room.latency[oldName];
    }
  }

  socket.on('join_room', (data = {}) => {
    const nextClientId = String(data.clientId || '').slice(0, 64);
    if (!nextClientId) return;

    const nextRoomId = sanitizeRoomId(data.room);
    const candidateRoom = getRoom(nextRoomId);
    const isRoomHost = candidateRoom.hostClientId === nextClientId;

    // Выгнанных не пускаем; в запароленную комнату — только с верным паролем (один раз на устройство)
    if (!isRoomHost && candidateRoom.banned.includes(nextClientId)) {
      logEvent(nextRoomId, '⛔ Выгнанный игрок пытался вернуться', 'warn');
      return socket.emit('join_denied', { reason: 'banned' });
    }
    if (!isRoomHost && candidateRoom.passwordHash && !candidateRoom.admitted.includes(nextClientId)) {
      if (passwordAttempts >= MAX_PASSWORD_ATTEMPTS) return socket.emit('join_denied', { reason: 'tooMany' });
      if (!data.password) return socket.emit('join_denied', { reason: 'password' });
      if (!checkRoomPassword(candidateRoom, data.password)) {
        passwordAttempts++;
        logEvent(nextRoomId, `⚠ Неверный пароль комнаты (попытка ${passwordAttempts} из ${MAX_PASSWORD_ATTEMPTS})`, 'warn');
        return socket.emit('join_denied', { reason: passwordAttempts >= MAX_PASSWORD_ATTEMPTS ? 'tooMany' : 'wrongPassword' });
      }
      candidateRoom.admitted.push(nextClientId);
    }

    if (conn.roomId && conn.roomId !== nextRoomId) leaveCurrentRoom();

    conn.roomId = nextRoomId;
    conn.clientId = nextClientId;
    const room = candidateRoom;

    let requested = sanitizeNick(data.nick);
    const previousOwner = requested ? room.nickOwners[requested] : null;
    let error = null;
    let errorKey = null;
    let errorParams = null;
    if (requested && !isNickFree(room, conn.roomId, requested, conn.clientId, socket.id)) {
      error = `Ник «${requested}» уже занят другим игроком в этой комнате`;
      errorKey = 'error.nickTaken';
      errorParams = { nick: requested };
      requested = '';
    }
    conn.nick = requested;
    if (conn.nick) takeOverNick(room, conn.roomId, conn.nick, conn.clientId, socket.id);

    // Первый зашедший в комнату становится хостом
    if (!room.hostClientId) room.hostClientId = conn.clientId;
    if (room.hostClientId === conn.clientId && conn.nick) room.host = conn.nick;

    socket.join(conn.roomId);
    if (!roomSockets[conn.roomId]) roomSockets[conn.roomId] = {};
    roomSockets[conn.roomId][socket.id] = { nick: conn.nick, clientId: conn.clientId };

    saveRooms();
    socket.emit('nick_state', { nick: conn.nick, error, errorKey, errorParams });
    ensureAudioTracks(conn.roomId);
    socket.emit('session_updated', publicRoom(room));
    socket.emit('chat_history', room.chat);
    socket.emit('recording_state', recordingList(conn.roomId));
    socket.emit('p2p_seeders', seedersSummary(conn.roomId));
    // Актуальное состояние просмотра: подхватить идущий или сбросить зависший
    if (watchState[conn.roomId]) socket.emit('watch_sync', watchState[conn.roomId]);
    else socket.emit('watch_stop', {});
    broadcastRoomUsers(conn.roomId);

    const who = conn.nick || 'игрок без ника';
    const returned = conn.nick && previousOwner && previousOwner !== conn.clientId ? ' (вернулся с нового адреса/устройства)' : '';
    if (error) logEvent(conn.roomId, `⚠ Кто-то пытался зайти под занятым ником «${sanitizeNick(data.nick)}»`, 'warn');
    logEvent(conn.roomId, `→ ${who} зашел${returned}. Онлайн: ${onlineCount(conn.roomId)}`);
  });

  socket.on('rename_user', (data = {}) => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    const newName = sanitizeNick(data.newName);
    if (!newName || newName === conn.nick) return socket.emit('nick_state', { nick: conn.nick });

    if (!isNickFree(room, conn.roomId, newName, conn.clientId, socket.id)) {
      return socket.emit('nick_state', {
        nick: conn.nick,
        error: `Ник «${newName}» уже занят другим игроком`,
        errorKey: 'error.nickTaken',
        errorParams: { nick: newName }
      });
    }

    const oldName = conn.nick;
    if (oldName && room.nickOwners[oldName] === conn.clientId) delete room.nickOwners[oldName];
    takeOverNick(room, conn.roomId, newName, conn.clientId, socket.id);
    conn.nick = newName;
    roomSockets[conn.roomId][socket.id].nick = newName;

    if (oldName) renameClaims(room, oldName, newName);
    if (room.hostClientId === conn.clientId) room.host = newName;
    logEvent(conn.roomId, `✎ ${oldName || 'игрок без ника'} теперь ${newName}`);

    saveRooms();
    socket.emit('nick_state', { nick: conn.nick });
    emitSession(conn.roomId);
    broadcastRoomUsers(conn.roomId);
  });

  // Если хост ушел, любой игрок может забрать права себе
  socket.on('claim_host', () => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    if (isHostOnline(conn.roomId)) return;

    room.hostClientId = conn.clientId;
    room.host = conn.nick;
    saveRooms();
    broadcastRoomUsers(conn.roomId);
    logEvent(conn.roomId, `👑 ${conn.nick} стал хостом`);
    addSystemMessage(conn.roomId, 'system.newHost', { nick: conn.nick }, `👑 ${conn.nick} теперь хост комнаты`);
  });

  // ---------- Чат ----------
  socket.on('chat_message', ({ text } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const clean = sanitizeChatText(text);
    if (!clean) return;

    const now = Date.now();
    chatTimestamps = chatTimestamps.filter(t => now - t < CHAT_RATE_LIMIT.windowMs);
    if (chatTimestamps.length >= CHAT_RATE_LIMIT.count) return;
    chatTimestamps.push(now);

    addChatMessage(conn.roomId, { nick: conn.nick, text: clean });
  });

  // ---------- Задержка микрофона игрока ----------
  // Одна поправка на все дубли игрока (например, для Bluetooth-наушников)
  socket.on('set_latency', ({ ms } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const value = Math.round(Number(ms));
    if (!Number.isFinite(value)) return;
    const room = getRoom(conn.roomId);
    const clamped = Math.max(-MAX_LATENCY_MS, Math.min(MAX_LATENCY_MS, value));
    if (clamped === 0) delete room.latency[conn.nick];
    else room.latency[conn.nick] = clamped;
    saveRooms();
    io.to(conn.roomId).emit('latency_updated', room.latency);
    logEvent(conn.roomId, `⏱ ${conn.nick}: поправка задержки ${clamped > 0 ? '+' : ''}${clamped} мс`);
  });

  // Синхронизация часов: клиент узнает, насколько его время отличается от серверного
  socket.on('time_sync', (clientTs, ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('disconnect', leaveCurrentRoom);
};
