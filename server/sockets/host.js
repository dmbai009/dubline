// Host rights: pause for everyone, password, kick, sessions, audio tracks, watch-together
const { roomSockets, recordingNow, p2pSeeders, watchState } = require('../state');
const { io } = require('../app');
const { sanitizeNick, sanitizeChatText } = require('../sanitize');
const { logEvent } = require('../log');
const { saveRooms, getRoom, emptySession, snapshotActive, activateSession, deleteSessionFiles, emitSession, ensureAudioTracks } = require('../rooms');
const { WATCH_COUNTDOWN_MS, endWatch, broadcastRecording, broadcastSeeders, onlineMembers, addSystemMessage } = require('../presence');
const { setRoomPassword, isHost } = require('../auth');
const { isDesktopRoom } = require('../desktop');
const history = require('../editHistory');

module.exports = function registerHostHandlers(socket, conn) {
  // ---------- Host rights ----------
  socket.on('host_force_pause', () => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId)) return;

    io.to(conn.roomId).emit('force_pause', { by: conn.nick, sessionId: room.activeSessionId });
    logEvent(conn.roomId, `⏸ ${conn.nick} paused for everyone`);
    addSystemMessage(conn.roomId, 'system.forcePause', { nick: conn.nick }, `⏸ Host ${conn.nick} paused the video for everyone`);
  });
  // ---------- Room password and kicked players (host only) ----------
  socket.on('host_set_password', ({ password } = {}) => {
    if (!conn.roomId) return;
    if (isDesktopRoom(conn.roomId)) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId)) return;
    const clean = String(password || '').slice(0, 64);
    setRoomPassword(room, clean);
    // Everyone already in the room stays: their devices count as admitted
    if (clean) room.admitted = [...new Set(onlineMembers(conn.roomId).map(m => m.clientId))];
    saveRooms();
    emitSession(conn.roomId);
    if (clean) {
      addSystemMessage(conn.roomId, 'system.passwordSet', { nick: conn.nick }, `🔒 ${conn.nick} set a room password`);
      logEvent(conn.roomId, `🔒 ${conn.nick} set a room password`);
    } else {
      addSystemMessage(conn.roomId, 'system.passwordRemoved', { nick: conn.nick }, `🔓 ${conn.nick} removed the room password`);
      logEvent(conn.roomId, `🔓 ${conn.nick} removed the room password`);
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
    addSystemMessage(conn.roomId, 'system.kicked', { nick: victim }, `⛔ ${victim} was removed from the room`);
    logEvent(conn.roomId, `⛔ ${conn.nick} kicked ${victim}`);
  });

  socket.on('host_unban_all', () => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || !room.banned.length) return;
    const count = room.banned.length;
    room.banned = [];
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `✅ ${conn.nick} let kicked players back (${count})`);
  });

  // ---------- Sessions (host only) ----------
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
    resetSceneState('🎬 Watch-together stopped: the session changed');
    ensureAudioTracks(conn.roomId);
    saveRooms();
    emitSession(conn.roomId);
    addSystemMessage(conn.roomId, 'system.sessionSwitched', { nick: conn.nick, title: room.title }, `🎬 ${conn.nick} opened session "${room.title}"`);
    logEvent(conn.roomId, `🎬 ${conn.nick} opened session "${room.title}"`);
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
    logEvent(conn.roomId, `✎ Session renamed: "${clean}"`);
  });

  socket.on('host_delete_session', ({ id } = {}) => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || !room.sessions[id]) return;
    snapshotActive(room);
    const doomed = room.sessions[id];

    if (id === room.activeSessionId) {
      // Deleting the open session: switch to the most recent remaining one (or an empty room)
      room.activeSessionId = null;
      const next = Object.values(room.sessions)
        .filter(session => session.id !== id)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      if (next) activateSession(room, next.id);
      else Object.assign(room, emptySession());
      resetSceneState('🎬 Watch-together stopped: the session was deleted');
    }
    delete room.sessions[id];
    history.clear(conn.roomId, id);
    const takes = deleteSessionFiles(doomed);

    saveRooms();
    emitSession(conn.roomId);
    addSystemMessage(conn.roomId, 'system.sessionDeleted', { nick: conn.nick, title: doomed.title, takes }, `🗑 ${conn.nick} deleted session "${doomed.title}" (${takes} takes)`);
    logEvent(conn.roomId, `🗑 ${conn.nick} deleted session "${doomed.title}" and its files (${takes} takes)`);
  });

  // ---------- Audio tracks: what plays as original and as background (host picks) ----------
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
    const name = index => (index >= 0 ? tracks[index].label || tracks[index].language || `#${index + 1}` : 'none');
    logEvent(conn.roomId, `🎧 ${conn.nick}: original = ${name(room.originalTrack)}, background = ${name(room.backingTrack)}`);
  });

  // ---------- Watch-together ----------

  socket.on('host_watch_start', ({ position, rate = 1 } = {}) => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || !room.loaded) return;

    if (!Number.isFinite(position) || position < 0 || position > 43200 || ![1, 1.25, 1.5, 2, 3, 4].includes(rate)) return;
    const start = position;
    const state = { sessionId: room.activeSessionId, active: true, playing: true, position: start, rate, at: Date.now() + WATCH_COUNTDOWN_MS };
    watchState[conn.roomId] = state;
    io.to(conn.roomId).emit('watch_start', { ...state, by: conn.nick });
    addSystemMessage(conn.roomId, 'system.watchStart', { nick: conn.nick }, `🎬 ${conn.nick} started watch-together`);
    logEvent(conn.roomId, `🎬 ${conn.nick} started watch-together`);
  });

  socket.on('host_watch_sync', ({ playing, position, rate = 1, transient = false } = {}) => {
    if (!conn.roomId || !watchState[conn.roomId]) return;
    if (!isHost(getRoom(conn.roomId), conn.clientId)) return;
    if (typeof playing !== 'boolean' || !Number.isFinite(position) || position < 0 || position > 43200 || ![1, 1.25, 1.5, 2, 3, 4].includes(rate)) return;
    Object.assign(watchState[conn.roomId], { playing, position, rate, at: Date.now() });
    const recipients = socket.to(conn.roomId);
    (transient === true ? recipients.volatile : recipients).emit('watch_sync', watchState[conn.roomId]);
  });

  socket.on('host_watch_stop', () => {
    if (!conn.roomId || !isHost(getRoom(conn.roomId), conn.clientId)) return;
    if (endWatch(conn.roomId, conn.nick, `⏹ ${conn.nick} stopped watch-together`)) {
      addSystemMessage(conn.roomId, 'system.watchStop', { nick: conn.nick }, `⏹ ${conn.nick} stopped watch-together`);
    } else {
      // The server has no screening, but someone is stuck in one: reset it for everyone
      io.to(conn.roomId).emit('watch_stop', { by: conn.nick, sessionId: getRoom(conn.roomId).activeSessionId });
    }
  });
};
