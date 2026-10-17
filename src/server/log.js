const { rooms, roomSockets } = require('./state');
const { io } = require('./app');

// ==========================================
// EVENT LOG: the server console plus the browser console of the room host
// ==========================================
const DISCONNECT_REASONS = {
  'transport close': 'closed the tab or lost internet',
  'ping timeout': 'connection dropped (no reply from the browser)',
  'transport error': 'connection error',
  'client namespace disconnect': 'left',
  'server namespace disconnect': 'disconnected by the server',
  'server shutting down': 'server shutting down'
};

function logEvent(roomId, text, level = 'info') {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const line = `[${time}] ${roomId ? `[${roomId}] ` : ''}${text}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  const room = roomId && rooms[roomId];
  if (!room || !room.hostClientId) return;
  for (const [socketId, member] of Object.entries(roomSockets[roomId] || {})) {
    if (member.clientId === room.hostClientId) io.to(socketId).emit('host_log', { ts: Date.now(), level, text });
  }
}

module.exports = {
  DISCONNECT_REASONS,
  logEvent
};
