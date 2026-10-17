const { roomSockets } = require('./state');
const { getRoom } = require('./rooms');
const { fileHashForUrl, fileSizeForUrl } = require('./files');
const records = new Map();
const states = new Set(['downloading', 'preparing', 'ready', 'buffering', 'fallback', 'failed']);
const TTL = 20000;
function identity(room) {
  const hash = fileHashForUrl(room.videoUrl), size = fileSizeForUrl(room.videoUrl);
  return hash && size ? `${hash}:${size}:262144:1` : null;
}
function snapshot(roomId) {
  const room = getRoom(roomId), mediaId = identity(room);
  const actors = new Map();
  for (const [socketId, entry] of records) {
    const member = roomSockets[entry.roomId]?.[socketId];
    if (!member || entry.updatedAt + TTL < Date.now() || getRoom(entry.roomId).activeSessionId !== entry.sessionId) { records.delete(socketId); continue; }
    if (entry.roomId !== roomId || entry.mediaId !== mediaId) continue;
    const report = { ...entry, nick: member.nick, actorId: socketId }; delete report.roomId;
    const previous = actors.get(member.clientId);
    if (!previous || previous.updatedAt <= entry.updatedAt) actors.set(member.clientId, report);
  }
  return { sessionId: room.activeSessionId, mediaId, players: [...actors.values()] };
}
function broadcast(roomId, reliable = true) {
  const recipients = require('./app').io.to(roomId);
  (reliable ? recipients : recipients.volatile).emit('media_presence', snapshot(roomId));
}
function clear(socketId, roomId) { if (records.delete(socketId)) broadcast(roomId); }
function register(socket, conn) {
  let lastReport = 0;
  socket.on('media_presence_update', (data = {}) => {
    if (!conn.roomId || !conn.nick || !roomSockets[conn.roomId]?.[socket.id] || !states.has(data.state)) return;
    const room = getRoom(conn.roomId);
    if (data.sessionId !== room.activeSessionId || !data.mediaId || data.mediaId !== identity(room)) return;
    const before = records.get(socket.id), terminal = ['ready', 'failed', 'fallback'].includes(data.state);
    if (before?.state === data.state && Date.now() - lastReport < 250) return;
    const bounded = (value, max) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;
    const buckets = Array.isArray(data.buckets) && data.buckets.length >= 64 && data.buckets.length <= 160 ? data.buckets.map(value => Math.round(bounded(value, 100))) : [];
    records.set(socket.id, { roomId: conn.roomId, clientId: conn.clientId, sessionId: room.activeSessionId, mediaId: data.mediaId,
      state: data.state, pct: bounded(data.pct, 100), bufferedSeconds: bounded(data.bufferedSeconds, 3600),
      downloadRate: bounded(data.downloadRate, 1024 ** 3), uploadRate: bounded(data.uploadRate, 1024 ** 3), buckets, updatedAt: Date.now() });
    lastReport = Date.now(); broadcast(conn.roomId, terminal || before?.state !== data.state);
  });
}
setInterval(() => {
  const expiredRooms = new Set();
  for (const [socketId, entry] of records) if (entry.updatedAt + TTL < Date.now() || !roomSockets[entry.roomId]?.[socketId]) { records.delete(socketId); expiredRooms.add(entry.roomId); }
  expiredRooms.forEach(roomId => broadcast(roomId));
}, 3000).unref();
module.exports = { register, snapshot, broadcast, clear, identity };
