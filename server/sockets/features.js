// Random casting, spoiler-only Blind Mode, and lightweight player activity statuses.
const { io } = require('../app');
const { getRoom, saveRooms, snapshotActive, emitSession } = require('../rooms');
const { canModerate } = require('../auth');
const { onlineMembers, addSystemMessage } = require('../presence');

module.exports = function registerFeatureHandlers(socket, conn) {
  socket.on('random_cast', () => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!canModerate(room, conn.clientId) || room.mode !== 'dub') return;
    const players = [...new Set(onlineMembers(conn.roomId).map(member => member.nick).filter(Boolean))];
    // Empty editor tracks have no work and must not consume a player's turn.
    const roles = [...new Set(room.lines.map(line => line.character).filter(Boolean))];
    if (!players.length || !roles.length) return;
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j], players[i]];
    }
    room.characterClaims = Object.create(null);
    room.lines.forEach(line => { line.claimedBy = null; });
    roles.forEach((role, index) => { room.characterClaims[role] = players[index % players.length]; });
    room.lines.forEach(line => { line.claimedBy = room.characterClaims[line.character] || null; });
    room.updatedAt = Date.now();
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    addSystemMessage(conn.roomId, 'system.randomCast', { nick: conn.nick }, `🎲 ${conn.nick} randomized the cast`);
  });

  socket.on('set_blind_mode', ({ enabled } = {}) => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!canModerate(room, conn.clientId)) return;
    room.blindMode = !!enabled;
    if (room.blindMode) room.lines.forEach(line => { if (line.audioUrl) line.blindRevealed = false; });
    room.updatedAt = Date.now();
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
  });

  socket.on('set_blind_preference', ({ enabled } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    const names = new Set(room.blindPlayers || []);
    if (enabled) names.add(conn.nick);
    else names.delete(conn.nick);
    room.blindPlayers = [...names];
    if (enabled) room.lines.forEach(line => { if (line.recordedBy === conn.nick && line.audioUrl) line.blindRevealed = false; });
    saveRooms();
    emitSession(conn.roomId);
  });

  socket.on('host_reveal_takes', () => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!canModerate(room, conn.clientId)) return;
    room.lines.forEach(line => { if (line.audioUrl) line.blindRevealed = true; });
    saveRooms();
    emitSession(conn.roomId);
    addSystemMessage(conn.roomId, 'system.takesRevealed', { nick: conn.nick }, `👁 ${conn.nick} revealed the takes`);
  });

  socket.on('player_activity', ({ state, pct } = {}) => {
    if (!conn.roomId || !conn.nick || !['idle', 'downloading'].includes(state)) return;
    const progress = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    io.to(conn.roomId).volatile.emit('player_activity_update', { nick: conn.nick, state, pct: progress });
  });
};
