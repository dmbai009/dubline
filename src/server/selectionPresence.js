// Ephemeral collaboration hints. Socket identity is authoritative; nicknames and
// selections supplied by the payload never enter the persistent room/session.
const selections = new Map();
const { io } = require('./app');
const { roomSockets } = require('./state');
const TTL_MS = 6000, epoch = require('node:crypto').randomUUID(), versions = new WeakMap();

function snapshot(roomId) {
  const room = require('./rooms').getRoom(roomId);
  const ids = new Set(room.lines.map(line => line.id));
  const result = [];
  for (const [socketId, entry] of selections) {
    if (entry.roomId !== roomId) continue;
    const actor = roomSockets[roomId]?.[socketId];
    if (!actor?.nick || entry.sessionId !== room.activeSessionId || entry.expires <= Date.now()) { selections.delete(socketId); continue; }
    entry.lineIds = entry.lineIds.filter(id => ids.has(id));
    if (!entry.lineIds.length) { selections.delete(socketId); continue; }
    result.push({ actorId: socketId, nick: actor.nick, sessionId: entry.sessionId, lineIds: entry.lineIds, seq: entry.seq, ttlMs: entry.expires - Date.now() });
  }
  const version = (versions.get(room) || 0) + 1; versions.set(room, version);
  return { sessionId: room.activeSessionId, selections: result, epoch, version };
}
function broadcast(roomId) { io.to(roomId).emit('selection_presence', snapshot(roomId)); }
function clear(socketId, roomId) {
  if (selections.delete(socketId) && roomId) broadcast(roomId);
}
function register(socket, conn) {
  let lastAt = 0, deferred = null, lastSeq = -1;
  socket.on('selection_update', data => {
    if (!data || !conn.roomId || !conn.nick || !roomSockets[conn.roomId]?.[socket.id]) return;
    const room = require('./rooms').getRoom(conn.roomId);
    if (!room.loaded || room.singlePlayer || data.sessionId !== room.activeSessionId || !Array.isArray(data.lineIds) || data.lineIds.length > 2000 || data.lineIds.some(id => !Number.isSafeInteger(id))) return;
    const seq = data.seq === undefined ? lastSeq + 1 : data.seq;
    if (!Number.isSafeInteger(seq) || seq <= lastSeq) return;
    lastSeq = seq;
    const existing = new Set(room.lines.map(line => line.id));
    const lineIds = [...new Set(data.lineIds)].filter(id => existing.has(id));
    if (lineIds.length) selections.set(socket.id, { roomId: conn.roomId, sessionId: data.sessionId, lineIds, seq, expires: Date.now() + TTL_MS });
    else selections.delete(socket.id);
    // Coalesce abusive/high-frequency updates while preserving the latest state.
    if (Date.now() - lastAt >= 40) { lastAt = Date.now(); broadcast(conn.roomId); }
    else if (!deferred) deferred = setTimeout(() => { deferred = null; lastAt = Date.now(); if (conn.roomId) broadcast(conn.roomId); }, 40);
  });
  socket.on('disconnect', () => { clearTimeout(deferred); deferred = null; clear(socket.id, conn.roomId); });
}
setInterval(() => {
  const roomIds = new Set([...selections.values()].filter(entry => entry.expires <= Date.now()).map(entry => entry.roomId));
  roomIds.forEach(broadcast);
}, 1000).unref();
module.exports = { snapshot, broadcast, clear, register, TTL_MS };
