const { rooms, roomSockets } = require('./state');
const { io } = require('./app');

// ==========================================
// ЖУРНАЛ СОБЫТИЙ: консоль сервера + консоль браузера у хоста комнаты
// ==========================================
const DISCONNECT_REASONS = {
  'transport close': 'закрыл вкладку или пропал интернет',
  'ping timeout': 'связь оборвалась (нет ответа от браузера)',
  'transport error': 'ошибка соединения',
  'client namespace disconnect': 'вышел сам',
  'server namespace disconnect': 'отключен сервером',
  'server shutting down': 'сервер выключается'
};

function logEvent(roomId, text, level = 'info') {
  const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
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
