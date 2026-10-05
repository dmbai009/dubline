// Trust boundary between the local Electron window and browsers arriving through the tunnel.
// The random host token is never sent through the public URL; the room PIN is stored only as a hash.
const crypto = require('crypto');
const { sanitizeRoomId } = require('./sanitize');

const desktopRoomId = String(process.env.DUBLINE_DESKTOP_ROOM || 'main');
const desktopHostToken = String(process.env.DUBLINE_DESKTOP_HOST_TOKEN || '');
const desktopRoomPin = String(process.env.DUBLINE_ROOM_PIN || '').toUpperCase();

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The Electron app hosts exactly one PIN-protected room; the browser server (start.bat) has any number
function isDesktopMode() {
  return !!desktopHostToken;
}

function isDesktopRoom(roomId) {
  return isDesktopMode() && roomId === desktopRoomId;
}

// In the desktop app every requested room is the protected one: otherwise anyone with the public link
// could open ?room=other, become its host without the PIN and upload files to the host's disk
function resolveRoomId(raw) {
  return isDesktopMode() ? desktopRoomId : sanitizeRoomId(raw);
}

// Scene media, takes and the pack library are served over plain HTTP, where the socket's PIN check
// does not apply. The page mirrors its device id into a cookie, so in the desktop app a request is let
// through only for a device that is the host or has passed the PIN (and was not kicked).
const CLIENT_COOKIE = 'dubline_client';

function clientIdFromCookie(header) {
  const match = new RegExp(`(?:^|;\\s*)${CLIENT_COOKIE}=([^;]*)`).exec(String(header || ''));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]).slice(0, 64);
  } catch (err) {
    return '';
  }
}

function canAccessMedia(clientId) {
  if (!isDesktopMode()) return true;
  if (!clientId) return false;
  const { getRoom } = require('./rooms');
  const room = getRoom(desktopRoomId);
  if (room.banned.includes(clientId)) return false;
  if (room.singlePlayer) return room.hostClientId === clientId;
  return room.hostClientId === clientId || !room.passwordHash || room.admitted.includes(clientId);
}

function mediaAccessGate(req, res, next) {
  if (canAccessMedia(clientIdFromCookie(req.headers.cookie))) return next();
  res.status(403).json({ error: 'Enter the room PIN first', key: 'error.pinRequired', params: {} });
}

function hasDesktopHostProof(roomId, token) {
  return isDesktopRoom(roomId) && safeEqual(token, desktopHostToken);
}

function configureDesktopRoom() {
  if (!desktopHostToken || !/^[A-Z0-9]{4}$/.test(desktopRoomPin)) return false;
  const { getRoom, saveRooms } = require('./rooms');
  const { setRoomPassword } = require('./auth');
  const room = getRoom(desktopRoomId);
  room.singlePlayer = process.env.DUBLINE_SINGLE_PLAYER === '1';
  setRoomPassword(room, room.singlePlayer ? '' : desktopRoomPin);
  room.admitted = [];
  room.host = null;
  room.hostClientId = null;
  saveRooms();
  return true;
}

function enableMultiplayer() {
  const { getRoom, flushRooms, emitSession } = require('./rooms');
  const { setRoomPassword } = require('./auth');
  const room = getRoom(desktopRoomId);
  if (room.singlePlayer) {
    room.singlePlayer = false;
    setRoomPassword(room, desktopRoomPin);
    flushRooms();
    emitSession(desktopRoomId);
  }
}

module.exports = {
  desktopRoomId,
  isDesktopRoom,
  resolveRoomId,
  clientIdFromCookie,
  mediaAccessGate,
  hasDesktopHostProof,
  configureDesktopRoom,
  enableMultiplayer
};
