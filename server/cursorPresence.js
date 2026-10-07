const { roomSockets } = require('./state');
const { normalize } = require('../public/cursor-model');
const settings = new Map(), subscribers = new Map();
function hz(roomId) { return settings.get(roomId) || 15; }
function roster(roomId) {
  const room = require('./rooms').getRoom(roomId);
  return { sessionId: room.activeSessionId, hz: hz(roomId), actors: Object.entries(roomSockets[roomId] || {}).filter(([, member]) => member.nick).map(([actorId, member]) => ({ actorId, nick: member.nick, receive: subscribers.get(actorId) !== false })) };
}
function broadcast(roomId) { require('./app').io.to(roomId).emit('cursor_roster', roster(roomId)); }
function clear(socketId, roomId) { subscribers.delete(socketId); if (roomId) broadcast(roomId); }
function register(socket, conn) {
  let lastAt = 0, lastSeq = -1, lastSession = null, signalAt = Date.now(), signals = 0;
  const confirmed = () => conn.roomId && conn.nick && roomSockets[conn.roomId]?.[socket.id]?.clientId === conn.clientId;
  socket.on('cursor_subscribe', (data = {}) => { if (!confirmed() || typeof data.enabled !== 'boolean') return; subscribers.set(socket.id, data.enabled); broadcast(conn.roomId); });
  socket.on('cursor_set_hz', (data = {}, ack) => {
    if (!confirmed() || require('./rooms').getRoom(conn.roomId).hostClientId !== conn.clientId || !Number.isInteger(data.hz) || data.hz < 5 || data.hz > 30) return;
    settings.set(conn.roomId, data.hz); broadcast(conn.roomId); if (typeof ack === 'function') ack({ ok: true, hz: data.hz });
  });
  socket.on('cursor_fallback', (data = {}) => {
    if (!confirmed() || !Array.isArray(data.to) || data.to.length > 64) return;
    const room = require('./rooms').getRoom(conn.roomId);
    if (room.mode !== 'edit' || room.singlePlayer) return;
    const packet = normalize(data.packet, room.activeSessionId, room.trackOrder);
    if (!packet) return;
    if (lastSession !== packet.sessionId) { lastSession = packet.sessionId; lastSeq = -1; }
    if (packet.seq <= lastSeq || packet.active && Date.now() - lastAt < 1000 / hz(conn.roomId) - 5) return;
    lastSeq = packet.seq; lastAt = Date.now();
    const allowed = [...new Set(data.to)].filter(id => typeof id === 'string' && id !== socket.id && roomSockets[conn.roomId]?.[id]?.nick && subscribers.get(id) !== false);
    for (const id of allowed) require('./app').io.to(id).volatile.emit('cursor_packet', { actorId: socket.id, packet });
  });
  socket.on('cursor_signal', (data = {}) => {
    if (!confirmed() || !roomSockets[conn.roomId]?.[data.to]?.nick || data.to === socket.id) return;
    const room = require('./rooms').getRoom(conn.roomId);
    if (room.mode !== 'edit' || room.singlePlayer || data.sessionId !== room.activeSessionId || !['offer', 'answer', 'candidate'].includes(data.signal?.kind) || JSON.stringify(data.signal).length > 32768) return;
    if (Date.now() - signalAt > 60000) { signalAt = Date.now(); signals = 0; }
    if (++signals > 200) return;
    require('./app').io.to(data.to).emit('cursor_signal', { actorId: socket.id, sessionId: room.activeSessionId, signal: data.signal });
  });
  socket.on('disconnect', () => clear(socket.id, conn.roomId));
}
module.exports = { register, broadcast, clear, roster, hz };
