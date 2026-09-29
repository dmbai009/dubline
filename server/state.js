
// Общее состояние сервера в памяти: все модули работают с одними и теми же объектами
const rooms = {};        // комнаты (загружаются с диска в rooms.js)
const roomSockets = {};  // { roomId: { socketId: { nick, clientId } } }
const recordingNow = {}; // roomId -> { lineId: { nick, socketId } }
const p2pSeeders = {};   // roomId -> { url: Set(socketId) } — у кого из игроков уже есть медиафайл целиком
const watchState = {};   // roomId -> { active, playing, position, at }

module.exports = {
  rooms,
  roomSockets,
  recordingNow,
  p2pSeeders,
  watchState
};
