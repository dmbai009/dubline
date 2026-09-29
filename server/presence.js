// Кто онлайн, статус записи, P2P-раздающие, совместный просмотр и чат комнаты
const { MAX_CHAT_HISTORY } = require('./config');
const { roomSockets, recordingNow, p2pSeeders, watchState } = require('./state');
const { io } = require('./app');
const { logEvent } = require('./log');
const { saveRooms, getRoom } = require('./rooms');

function onlineCount(roomId) {
  return new Set(onlineMembers(roomId).map(m => m.clientId)).size;
}

// ==========================================
// СТАТУС ЗАПИСИ И СОВМЕСТНЫЙ ПРОСМОТР (живут только в памяти)
// ==========================================
const WATCH_COUNTDOWN_MS = 3000;

// Завершает совместный просмотр и обязательно сообщает об этом всем браузерам,
// иначе у игроков останется включенным режим просмотра (и заблокированная запись)
function endWatch(roomId, by, reason) {
  if (!watchState[roomId]) return false;
  delete watchState[roomId];
  io.to(roomId).emit('watch_stop', { by });
  if (reason) logEvent(roomId, reason);
  return true;
}

function recordingList(roomId) {
  return Object.entries(recordingNow[roomId] || {}).map(([lineId, rec]) => ({ lineId: Number(lineId), nick: rec.nick }));
}

function broadcastRecording(roomId) {
  io.to(roomId).emit('recording_state', recordingList(roomId));
}

function clearSocketSeeds(roomId, socketId) {
  const byUrl = p2pSeeders[roomId];
  if (!byUrl) return false;
  let changed = false;
  for (const url of Object.keys(byUrl)) {
    if (byUrl[url].delete(socketId)) changed = true;
    if (!byUrl[url].size) delete byUrl[url];
  }
  return changed;
}

function seedersSummary(roomId) {
  const summary = {};
  for (const [url, ids] of Object.entries(p2pSeeders[roomId] || {})) {
    summary[url] = [...ids].map(id => (roomSockets[roomId] && roomSockets[roomId][id] || {}).nick).filter(Boolean);
  }
  return summary;
}

function broadcastSeeders(roomId) {
  io.to(roomId).emit('p2p_seeders', seedersSummary(roomId));
}

function clearSocketRecordings(roomId, socketId) {
  const map = recordingNow[roomId];
  if (!map) return false;
  let changed = false;
  for (const lineId of Object.keys(map)) {
    if (map[lineId].socketId === socketId) {
      delete map[lineId];
      changed = true;
    }
  }
  return changed;
}

function onlineMembers(roomId) {
  return Object.values(roomSockets[roomId] || {});
}

function isHostOnline(roomId) {
  const room = getRoom(roomId);
  return onlineMembers(roomId).some(m => m.clientId === room.hostClientId);
}

function broadcastRoomUsers(roomId) {
  const room = getRoom(roomId);
  const users = [...new Set(onlineMembers(roomId).map(m => m.nick).filter(Boolean))];
  io.to(roomId).emit('room_users_updated', { users, host: room.host, hostOnline: isHostOnline(roomId) });
}

function addChatMessage(roomId, message) {
  const room = getRoom(roomId);
  const entry = { ts: Date.now(), ...message };
  room.chat.push(entry);
  if (room.chat.length > MAX_CHAT_HISTORY) room.chat.splice(0, room.chat.length - MAX_CHAT_HISTORY);
  io.to(roomId).emit('chat_message', entry);
  saveRooms();
}

function addSystemMessage(roomId, key, params = {}, fallback = '') {
  addChatMessage(roomId, { system: true, key, params, text: fallback });
}

module.exports = {
  onlineCount,
  WATCH_COUNTDOWN_MS,
  endWatch,
  recordingList,
  broadcastRecording,
  clearSocketSeeds,
  seedersSummary,
  broadcastSeeders,
  clearSocketRecordings,
  onlineMembers,
  isHostOnline,
  broadcastRoomUsers,
  addChatMessage,
  addSystemMessage
};
