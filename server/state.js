
// Shared in-memory server state: all modules work with the same objects
const rooms = {};        // rooms (loaded from disk in rooms.js)
const roomSockets = {};  // { roomId: { socketId: { nick, clientId } } }
const recordingNow = {}; // roomId -> { lineId: { nick, socketId } }
const p2pSeeders = {};   // roomId -> { url: Set(socketId) }: players who already have the whole media file
const watchState = {};   // roomId -> { active, playing, position, at }

module.exports = {
  rooms,
  roomSockets,
  recordingNow,
  p2pSeeders,
  watchState
};
