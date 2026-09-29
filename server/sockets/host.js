// Права хоста: пауза у всех, пароль, кик, сессии, звуковые дорожки, совместный просмотр
const { roomSockets, recordingNow, p2pSeeders, watchState } = require('../state');
const { io } = require('../app');
const { sanitizeNick, sanitizeChatText } = require('../sanitize');
const { logEvent } = require('../log');
const { saveRooms, getRoom, emptySession, snapshotActive, activateSession, deleteSessionFiles, emitSession, ensureAudioTracks } = require('../rooms');
const { WATCH_COUNTDOWN_MS, endWatch, broadcastRecording, broadcastSeeders, onlineMembers, addSystemMessage } = require('../presence');
const { setRoomPassword, isHost } = require('../auth');

module.exports = function registerHostHandlers(socket, conn) {
  // ---------- Права хоста ----------
  socket.on('host_force_pause', () => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId)) return;

    io.to(conn.roomId).emit('force_pause', { by: conn.nick });
    logEvent(conn.roomId, `⏸ ${conn.nick} поставил паузу у всех`);
    addSystemMessage(conn.roomId, 'system.forcePause', { nick: conn.nick }, `⏸ Хост ${conn.nick} поставил видео на паузу у всех`);
  });
  // ---------- Пароль комнаты и выгнанные (управляет хост) ----------
  socket.on('host_set_password', ({ password } = {}) => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId)) return;
    const clean = String(password || '').slice(0, 64);
    setRoomPassword(room, clean);
    // Все, кто уже в комнате, остаются: их устройства считаем допущенными
    if (clean) room.admitted = [...new Set(onlineMembers(conn.roomId).map(m => m.clientId))];
    saveRooms();
    emitSession(conn.roomId);
    if (clean) {
      addSystemMessage(conn.roomId, 'system.passwordSet', { nick: conn.nick }, `🔒 ${conn.nick} поставил пароль на комнату`);
      logEvent(conn.roomId, `🔒 ${conn.nick} поставил пароль на комнату`);
    } else {
      addSystemMessage(conn.roomId, 'system.passwordRemoved', { nick: conn.nick }, `🔓 ${conn.nick} убрал пароль комнаты`);
      logEvent(conn.roomId, `🔓 ${conn.nick} убрал пароль комнаты`);
    }
  });

  socket.on('host_kick', ({ nick: target } = {}) => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    const victim = sanitizeNick(target);
    if (!isHost(room, conn.clientId) || !victim || victim === conn.nick) return;

    const victims = Object.entries(roomSockets[conn.roomId] || {}).filter(([, member]) => member.nick === victim);
    const ids = new Set(victims.map(([, member]) => member.clientId));
    if (room.nickOwners[victim]) ids.add(room.nickOwners[victim]);
    ids.delete(room.hostClientId);
    if (!ids.size) return;

    room.banned = [...new Set([...room.banned, ...ids])];
    room.admitted = room.admitted.filter(id => !ids.has(id));
    delete room.nickOwners[victim];
    saveRooms();

    victims.forEach(([socketId]) => {
      const target = io.sockets.sockets.get(socketId);
      if (target) {
        target.emit('kicked', { by: conn.nick });
        target.disconnect(true);
      }
    });
    emitSession(conn.roomId);
    addSystemMessage(conn.roomId, 'system.kicked', { nick: victim }, `⛔ ${victim} удален из комнаты`);
    logEvent(conn.roomId, `⛔ ${conn.nick} выгнал ${victim}`);
  });

  socket.on('host_unban_all', () => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || !room.banned.length) return;
    const count = room.banned.length;
    room.banned = [];
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `✅ ${conn.nick} разрешил вернуться выгнанным (${count})`);
  });

  // ---------- Сессии (управляет хост) ----------
  function resetSceneState(reason) {
    delete recordingNow[conn.roomId];
    endWatch(conn.roomId, null, reason);
    delete p2pSeeders[conn.roomId];
    broadcastRecording(conn.roomId);
    broadcastSeeders(conn.roomId);
  }

  socket.on('host_switch_session', ({ id } = {}) => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || !room.sessions[id] || id === room.activeSessionId) return;
    activateSession(room, id);
    resetSceneState('🎬 Совместный просмотр остановлен: сменилась сессия');
    ensureAudioTracks(conn.roomId);
    saveRooms();
    emitSession(conn.roomId);
    addSystemMessage(conn.roomId, 'system.sessionSwitched', { nick: conn.nick, title: room.title }, `🎬 ${conn.nick} открыл сессию «${room.title}»`);
    logEvent(conn.roomId, `🎬 ${conn.nick} открыл сессию «${room.title}»`);
  });

  socket.on('host_rename_session', ({ id, title } = {}) => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    const clean = sanitizeChatText(title).slice(0, 80);
    if (!isHost(room, conn.clientId) || !room.sessions[id] || !clean) return;
    if (id === room.activeSessionId) room.title = clean;
    room.sessions[id].title = clean;
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `✎ Сессия переименована: «${clean}»`);
  });

  socket.on('host_delete_session', ({ id } = {}) => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || !room.sessions[id]) return;
    snapshotActive(room);
    const doomed = room.sessions[id];

    if (id === room.activeSessionId) {
      // Удаляем открытую — переходим на самую свежую из оставшихся (или на пустую комнату)
      room.activeSessionId = null;
      const next = Object.values(room.sessions)
        .filter(session => session.id !== id)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      if (next) activateSession(room, next.id);
      else Object.assign(room, emptySession());
      resetSceneState('🎬 Совместный просмотр остановлен: сессия удалена');
    }
    delete room.sessions[id];
    const takes = deleteSessionFiles(doomed);

    saveRooms();
    emitSession(conn.roomId);
    addSystemMessage(conn.roomId, 'system.sessionDeleted', { nick: conn.nick, title: doomed.title, takes }, `🗑 ${conn.nick} удалил сессию «${doomed.title}» (${takes} дублей)`);
    logEvent(conn.roomId, `🗑 ${conn.nick} удалил сессию «${doomed.title}» и ее файлы (${takes} дублей)`);
  });

  // ---------- Звуковые дорожки: что играет как оригинал и как интершум (выбирает хост) ----------
  socket.on('host_set_audio_tracks', ({ original, backing } = {}) => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    const tracks = room.audioTracks || [];
    if (!isHost(room, conn.clientId) || !tracks.length) return;
    const valid = value => Number.isInteger(value) && value >= -1 && value < tracks.length;
    if (valid(original)) room.originalTrack = original;
    if (valid(backing)) room.backingTrack = backing;
    if (room.baseBackingUrl === undefined) room.baseBackingUrl = room.backingUrl || '';
    room.backingUrl = room.backingTrack >= 0 ? tracks[room.backingTrack].url : room.baseBackingUrl;
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    const name = index => (index >= 0 ? tracks[index].label || `#${index + 1}` : 'нет');
    logEvent(conn.roomId, `🎧 ${conn.nick}: оригинал — ${name(room.originalTrack)}, интершум — ${name(room.backingTrack)}`);
  });

  // ---------- Совместный просмотр ----------

  socket.on('host_watch_start', ({ position } = {}) => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || !room.loaded) return;

    const start = Math.max(0, Number(position) || 0);
    const state = { active: true, playing: true, position: start, at: Date.now() + WATCH_COUNTDOWN_MS };
    watchState[conn.roomId] = state;
    io.to(conn.roomId).emit('watch_start', { ...state, by: conn.nick });
    addSystemMessage(conn.roomId, 'system.watchStart', { nick: conn.nick }, `🎬 ${conn.nick} запустил совместный просмотр`);
    logEvent(conn.roomId, `🎬 ${conn.nick} запустил совместный просмотр`);
  });

  socket.on('host_watch_sync', ({ playing, position } = {}) => {
    if (!conn.roomId || !watchState[conn.roomId]) return;
    if (!isHost(getRoom(conn.roomId), conn.clientId)) return;
    Object.assign(watchState[conn.roomId], { playing: !!playing, position: Math.max(0, Number(position) || 0), at: Date.now() });
    socket.to(conn.roomId).volatile.emit('watch_sync', watchState[conn.roomId]);
  });

  socket.on('host_watch_stop', () => {
    if (!conn.roomId || !isHost(getRoom(conn.roomId), conn.clientId)) return;
    if (endWatch(conn.roomId, conn.nick, `⏹ ${conn.nick} остановил совместный просмотр`)) {
      addSystemMessage(conn.roomId, 'system.watchStop', { nick: conn.nick }, `⏹ ${conn.nick} остановил совместный просмотр`);
    } else {
      // На сервере просмотра уже нет, а у кого-то он «завис» — сбрасываем у всех
      io.to(conn.roomId).emit('watch_stop', { by: conn.nick });
    }
  });
};
