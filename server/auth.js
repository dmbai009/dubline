// Nicknames, host rights and the room password
const crypto = require('crypto');
const { roomSockets } = require('./state');

// A nickname belongs to a device (clientId) while its owner is online in the room.
// Once the owner leaves, the nickname can be taken again, e.g. after a tunnel restart
// (new address = empty localStorage = new clientId) or from another device.
function isClientOnline(roomId, clientId, exceptSocketId = null) {
  return Object.entries(roomSockets[roomId] || {})
    .some(([socketId, member]) => socketId !== exceptSocketId && member.clientId === clientId);
}

function isNickFree(room, roomId, nick, clientId, exceptSocketId = null) {
  const owner = room.nickOwners[nick];
  return !owner || owner === clientId || !isClientOnline(roomId, owner, exceptSocketId);
}

// A returning player takes their nickname back, and host rights too if they were the host
function takeOverNick(room, roomId, nick, clientId, exceptSocketId = null) {
  const previousOwner = room.nickOwners[nick];
  room.nickOwners[nick] = clientId;
  if (previousOwner && previousOwner !== clientId && room.hostClientId === previousOwner
      && room.host === nick && !isClientOnline(roomId, previousOwner, exceptSocketId)) {
    room.hostClientId = clientId;
  }
}

function isAuthorized(room, nick, clientId) {
  return !!nick && !!clientId && room.nickOwners[nick] === clientId;
}

// ==========================================
// ROOM PASSWORD AND KICKED PLAYERS
// ==========================================
const MAX_PASSWORD_ATTEMPTS = 5;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function setRoomPassword(room, password) {
  if (!password) {
    room.passwordHash = null;
    room.passwordSalt = null;
    room.admitted = [];
    return;
  }
  room.passwordSalt = crypto.randomBytes(16).toString('hex');
  room.passwordHash = hashPassword(password, room.passwordSalt);
}

function checkRoomPassword(room, password) {
  if (!room.passwordHash || !password) return false;
  const expected = Buffer.from(room.passwordHash, 'hex');
  const actual = Buffer.from(hashPassword(password, room.passwordSalt), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function isHost(room, clientId) {
  return !!clientId && room.hostClientId === clientId;
}

function getLineOwner(room, line) {
  return room.characterClaims[line.character] || line.claimedBy || null;
}

module.exports = {
  isNickFree,
  takeOverNick,
  isAuthorized,
  MAX_PASSWORD_ATTEMPTS,
  setRoomPassword,
  checkRoomPassword,
  isHost,
  getLineOwner
};
