// Short-lived, advisory reports. Never part of rooms, projects, or permissions.
const { roomSockets } = require('./state');
const records = new Map(), TTL = 15000;
function valid(data) {
  return data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length <= 3 &&
    ['rtt', 'up', 'down'].every(key => data[key] === null || typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0 && data[key] <= (key === 'rtt' ? 60000 : 1024 ** 3));
}
function snapshot(roomId) {
  const now = Date.now(), players = [];
  for (const [id, record] of records) {
    const member = roomSockets[record.roomId]?.[id];
    if (!member || now - record.at >= TTL) { records.delete(id); continue; }
    if (record.roomId === roomId) players.push({ actorId: id, nick: member.nick, rtt: record.rtt, up: record.up, down: record.down, age: now - record.at });
  }
  return { roomId, players };
}
function broadcast(roomId) { require('./app').io.to(roomId).volatile.emit('network_telemetry', snapshot(roomId)); }
function clear(id, roomId) { if (records.delete(id)) broadcast(roomId); }
function register(socket, conn) {
  let last = -Infinity;
  socket.on('network_telemetry_update', data => {
    if (!conn.roomId || !conn.nick || !roomSockets[conn.roomId]?.[socket.id] || require('./rooms').getRoom(conn.roomId).singlePlayer || Date.now() - last < 900 || !valid(data)) return;
    last = Date.now(); records.set(socket.id, { roomId: conn.roomId, at: last, rtt: data.rtt, up: data.up, down: data.down }); broadcast(conn.roomId);
  });
}
setInterval(() => {
  const rooms = new Set();
  for (const [id, record] of records) if (Date.now() - record.at >= TTL || !roomSockets[record.roomId]?.[id]) { records.delete(id); rooms.add(record.roomId); }
  rooms.forEach(broadcast);
}, 3000).unref();
module.exports = { register, snapshot, clear, valid, TTL };
