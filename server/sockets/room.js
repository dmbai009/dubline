// Joining a room, nicknames, host rights for a returning host, chat, microphone delay, clock
const { CHAT_RATE_LIMIT, MAX_LATENCY_MS } = require('../config');
const { roomSockets, watchState } = require('../state');
const { io } = require('../app');
const { sanitizeNick, sanitizeChatText } = require('../sanitize');
const { DISCONNECT_REASONS, logEvent } = require('../log');
const { saveRooms, flushRooms, getRoom, publicRoom, emitSession, ensureAudioTracks, snapshotActive } = require('../rooms');
const history = require('../editHistory');
const { onlineCount, endWatch, recordingList, broadcastRecording, clearSocketSeeds, seedersSummary, broadcastSeeders, clearSocketRecordings, isHostOnline, broadcastRoomUsers, addChatMessage, addSystemMessage } = require('../presence');
const { isNickFree, takeOverNick, MAX_PASSWORD_ATTEMPTS, checkRoomPassword, isPasswordLocked, notePasswordFailure, isHost } = require('../auth');
const { isDesktopRoom, hasDesktopHostProof, resolveRoomId } = require('../desktop');

module.exports = function registerRoomHandlers(socket, conn) {
  let chatTimestamps = [];
  let passwordAttempts = 0;

  function leaveCurrentRoom(reason) {
    if (conn.roomId && roomSockets[conn.roomId] && roomSockets[conn.roomId][socket.id]) {
      const room = getRoom(conn.roomId);
      const wasHost = isHost(room, conn.clientId);
      delete roomSockets[conn.roomId][socket.id];
      require('../selectionPresence').clear(socket.id, conn.roomId);
      socket.leave(conn.roomId);
      if (clearSocketRecordings(conn.roomId, socket.id)) broadcastRecording(conn.roomId);
      if (clearSocketSeeds(conn.roomId, socket.id)) broadcastSeeders(conn.roomId);
      broadcastRoomUsers(conn.roomId);

      const why = typeof reason === 'string' ? ` — ${DISCONNECT_REASONS[reason] || reason}` : '';
      logEvent(conn.roomId, `← ${conn.nick || 'player without a nickname'} left${why}. Online: ${onlineCount(conn.roomId)}`, reason === 'ping timeout' || reason === 'transport error' ? 'warn' : 'info');

      // The host is gone for good: watch-together ends
      if (wasHost && !isHostOnline(conn.roomId)) endWatch(conn.roomId, conn.nick, '🎬 Watch-together stopped: the host left');
    }
  }

  function renameClaims(room, oldName, newName) {
    if (Array.isArray(room.blindPlayers)) {
      room.blindPlayers = [...new Set(room.blindPlayers.map(nick => nick === oldName ? newName : nick))];
    }
    snapshotActive(room);
    for (const scene of Object.values(room.sessions)) {
      if (scene.takeLatency && Object.hasOwn(scene.takeLatency, oldName)) {
        if (!Object.hasOwn(scene.takeLatency, newName)) scene.takeLatency[newName] = scene.takeLatency[oldName];
        delete scene.takeLatency[oldName];
      }
      for (const char of Object.keys(scene.characterClaims || {})) {
        if (scene.characterClaims[char] === oldName) scene.characterClaims[char] = newName;
      }
      const renameLine = line => {
        if (line.claimedBy === oldName) line.claimedBy = newName;
        if (line.recordedBy === oldName) line.recordedBy = newName;
      };
      scene.lines.forEach(renameLine);
      for (const batch of scene.deletedLines || []) {
        if (batch.by === oldName) batch.by = newName;
        batch.lines.forEach(entry => renameLine(entry.line));
        for (const char of Object.keys(batch.claims || {})) {
          if (batch.claims[char] === oldName) batch.claims[char] = newName;
        }
      }
    }
    history.renameNick(conn.roomId, oldName, newName);
    if (room.latency[oldName] !== undefined && room.latency[newName] === undefined) {
      room.latency[newName] = room.latency[oldName];
      delete room.latency[oldName];
    }
  }

  socket.on('join_room', (data = {}) => {
    const nextClientId = String(data.clientId || '').slice(0, 64);
    if (!nextClientId) return;

    const nextRoomId = resolveRoomId(data.room);
    const candidateRoom = getRoom(nextRoomId);
    const desktopHost = hasDesktopHostProof(nextRoomId, data.desktopHostToken);
    if (desktopHost) {
      candidateRoom.hostClientId = nextClientId;
      if (!candidateRoom.admitted.includes(nextClientId)) candidateRoom.admitted.push(nextClientId);
    }
    const isRoomHost = desktopHost || candidateRoom.hostClientId === nextClientId;
    if (candidateRoom.singlePlayer && !isRoomHost) return socket.emit('join_denied', { reason: 'singlePlayer' });
    const pinProtected = isDesktopRoom(nextRoomId);

    // Kicked players are refused; a password-protected room needs the right password (once per device)
    if (!isRoomHost && candidateRoom.banned.includes(nextClientId)) {
      logEvent(nextRoomId, '⛔ A kicked player tried to come back', 'warn');
      return socket.emit('join_denied', { reason: 'banned' });
    }
    if (!isRoomHost && candidateRoom.passwordHash && !candidateRoom.admitted.includes(nextClientId)) {
      if (passwordAttempts >= MAX_PASSWORD_ATTEMPTS) return socket.emit('join_denied', { reason: 'tooMany', pin: pinProtected });
      if (!data.password) return socket.emit('join_denied', { reason: 'password', pin: pinProtected });
      if (isPasswordLocked(nextRoomId)) return socket.emit('join_denied', { reason: 'tooMany', pin: pinProtected });
      if (!checkRoomPassword(candidateRoom, data.password)) {
        passwordAttempts++;
        logEvent(nextRoomId, `⚠ Wrong room password (attempt ${passwordAttempts} of ${MAX_PASSWORD_ATTEMPTS})`, 'warn');
        if (notePasswordFailure(nextRoomId)) {
          logEvent(nextRoomId, '⛔ Too many wrong passwords from different devices: new players are refused for a few minutes', 'warn');
        }
        return socket.emit('join_denied', { reason: passwordAttempts >= MAX_PASSWORD_ATTEMPTS ? 'tooMany' : 'wrongPassword', pin: pinProtected });
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
      error = `Nickname "${requested}" is already used by another player in this room`;
      errorKey = 'error.nickTaken';
      errorParams = { nick: requested };
      requested = '';
    }
    conn.nick = requested;
    if (conn.nick) takeOverNick(room, conn.roomId, conn.nick, conn.clientId, socket.id);

    // The first player in the room becomes the host
    if (!room.hostClientId && !isDesktopRoom(conn.roomId)) room.hostClientId = conn.clientId;
    if (room.hostClientId === conn.clientId && conn.nick) room.host = conn.nick;

    socket.join(conn.roomId);
    if (!roomSockets[conn.roomId]) roomSockets[conn.roomId] = Object.create(null);
    roomSockets[conn.roomId][socket.id] = { nick: conn.nick, clientId: conn.clientId };

    // The Electron host uses this only as a positive readiness signal for VPN/Porthole modes.
    // It does not expose room data and is never sent for the desktop host itself.
    if (isDesktopRoom(conn.roomId) && !desktopHost && typeof process.send === 'function') {
      try { process.send({ type: 'desktop-guest-joined' }); } catch (err) { /* parent process closed */ }
    }

    saveRooms();
    socket.emit('nick_state', { nick: conn.nick, error, errorKey, errorParams });
    ensureAudioTracks(conn.roomId);
    socket.emit('session_updated', publicRoom(room));
    socket.emit('selection_presence', require('../selectionPresence').snapshot(conn.roomId));
    socket.emit('chat_history', room.chat);
    socket.emit('recording_state', recordingList(conn.roomId));
    socket.emit('p2p_seeders', seedersSummary(conn.roomId));
    // Current screening state: join a running one or reset a stuck one
    if (watchState[conn.roomId]) socket.emit('watch_sync', watchState[conn.roomId]);
    else socket.emit('watch_stop', {});
    broadcastRoomUsers(conn.roomId);

    const who = conn.nick || 'player without a nickname';
    const returned = conn.nick && previousOwner && previousOwner !== conn.clientId ? ' (returned from a new address/device)' : '';
    if (error) logEvent(conn.roomId, `⚠ Someone tried to join with the taken nickname "${sanitizeNick(data.nick)}"`, 'warn');
    logEvent(conn.roomId, `→ ${who} joined${returned}. Online: ${onlineCount(conn.roomId)}`);
  });

  socket.on('rename_user', (data = {}) => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    const newName = sanitizeNick(data.newName);
    if (!newName || newName === conn.nick) return socket.emit('nick_state', { nick: conn.nick });

    if (!isNickFree(room, conn.roomId, newName, conn.clientId, socket.id)) {
      return socket.emit('nick_state', {
        nick: conn.nick,
        error: `Nickname "${newName}" is already used by another player`,
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
    logEvent(conn.roomId, `✎ ${oldName || 'player without a nickname'} is now ${newName}`);

    flushRooms();
    socket.emit('nick_state', { nick: conn.nick });
    emitSession(conn.roomId);
    broadcastRoomUsers(conn.roomId);
  });

  // If the host has left, any player can take host rights
  socket.on('claim_host', () => {
    if (!conn.roomId || !conn.nick) return;
    if (isDesktopRoom(conn.roomId)) return;
    const room = getRoom(conn.roomId);
    if (isHostOnline(conn.roomId)) return;

    room.hostClientId = conn.clientId;
    room.host = conn.nick;
    saveRooms();
    broadcastRoomUsers(conn.roomId);
    logEvent(conn.roomId, `👑 ${conn.nick} became the host`);
    addSystemMessage(conn.roomId, 'system.newHost', { nick: conn.nick }, `👑 ${conn.nick} is now the room host`);
  });

  // ---------- Chat ----------
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

  // ---------- Player microphone delay ----------
  // One correction for all of a player's takes (e.g. for Bluetooth headphones)
  socket.on('set_latency', ({ ms } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const value = Math.round(Number(ms));
    if (!Number.isFinite(value)) return;
    const room = getRoom(conn.roomId);
    const clamped = Math.max(-MAX_LATENCY_MS, Math.min(MAX_LATENCY_MS, value));
    // Imported take alignment belongs to the session, but the existing delay tool
    // still adjusts all of this author's takes, including those imported scenes.
    snapshotActive(room);
    for (const scene of Object.values(room.sessions)) {
      if (scene.takeLatency && Object.hasOwn(scene.takeLatency, conn.nick)) scene.takeLatency[conn.nick] = clamped;
    }
    if (clamped === 0) delete room.latency[conn.nick];
    else room.latency[conn.nick] = clamped;
    saveRooms();
    io.to(conn.roomId).emit('latency_updated', room.latency);
    if (Object.hasOwn(room.takeLatency || {}, conn.nick)) emitSession(conn.roomId);
    logEvent(conn.roomId, `⏱ ${conn.nick}: delay correction ${clamped > 0 ? '+' : ''}${clamped} ms`);
  });

  // Clock sync: the client learns how far its time is from the server's
  socket.on('time_sync', (clientTs, ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('disconnect', leaveCurrentRoom);
};
