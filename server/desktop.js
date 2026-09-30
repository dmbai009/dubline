// Trust boundary between the local Electron window and browsers arriving through the tunnel.
// The random host token is never sent through the public URL; the room PIN is stored only as a hash.
const crypto = require('crypto');

const desktopRoomId = String(process.env.DUBLINE_DESKTOP_ROOM || 'main');
const desktopHostToken = String(process.env.DUBLINE_DESKTOP_HOST_TOKEN || '');
const desktopRoomPin = String(process.env.DUBLINE_ROOM_PIN || '').toUpperCase();

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isDesktopRoom(roomId) {
  return !!desktopHostToken && roomId === desktopRoomId;
}

function hasDesktopHostProof(roomId, token) {
  return isDesktopRoom(roomId) && safeEqual(token, desktopHostToken);
}

function configureDesktopRoom() {
  if (!desktopHostToken || !/^[A-Z0-9]{4}$/.test(desktopRoomPin)) return false;
  const { getRoom, saveRooms } = require('./rooms');
  const { setRoomPassword } = require('./auth');
  const room = getRoom(desktopRoomId);
  setRoomPassword(room, desktopRoomPin);
  room.admitted = [];
  room.host = null;
  room.hostClientId = null;
  saveRooms();
  return true;
}

module.exports = {
  desktopRoomId,
  isDesktopRoom,
  hasDesktopHostProof,
  configureDesktopRoom
};
