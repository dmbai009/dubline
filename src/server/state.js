
// Shared in-memory server state: all modules work with the same objects
const rooms = Object.create(null);        // rooms (loaded from disk in rooms.js)
const roomSockets = Object.create(null);  // { roomId: { socketId: { nick, clientId } } }
const recordingNow = Object.create(null); // roomId -> { lineId: { nick, socketId } }
const p2pSeeders = Object.create(null);   // roomId -> { url: Set(socketId) }
const watchState = Object.create(null);   // roomId -> { active, playing, position, at }

module.exports = {
  rooms,
  roomSockets,
  recordingNow,
  p2pSeeders,
  watchState
};
