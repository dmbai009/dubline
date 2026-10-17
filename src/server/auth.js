// Nicknames, host rights and the room password
const crypto = require('crypto');
const { PASSWORD_FAILURE_LIMIT } = require('./config');
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

// Recent wrong-password times per room, shared by all devices
const passwordFailures = new Map();

function recentPasswordFailures(roomId) {
  const now = Date.now();
  const recent = (passwordFailures.get(roomId) || []).filter(t => now - t < PASSWORD_FAILURE_LIMIT.windowMs);
  if (recent.length) passwordFailures.set(roomId, recent);
  else passwordFailures.delete(roomId);
  return recent;
}

function isPasswordLocked(roomId) {
  return recentPasswordFailures(roomId).length >= PASSWORD_FAILURE_LIMIT.count;
}

// Returns true when this failure locks the room
function notePasswordFailure(roomId) {
  const recent = recentPasswordFailures(roomId);
  recent.push(Date.now());
  passwordFailures.set(roomId, recent);
  return recent.length === PASSWORD_FAILURE_LIMIT.count;
}

function isHost(room, clientId) {
  return !!clientId && room.hostClientId === clientId;
}

function isModerator(room, clientId) {
  return !!clientId && !room.singlePlayer && !isHost(room, clientId) &&
    !(room.banned || []).includes(clientId) &&
    (room.moderators || []).some(entry => entry.clientId === clientId) &&
    Object.values(room.nickOwners || {}).includes(clientId);
}

function canModerate(room, clientId) { return isHost(room, clientId) || isModerator(room, clientId); }

function getLineOwner(room, line) {
  if (room.singlePlayer) return room.host;
  return (Object.hasOwn(room.characterClaims, line.character) && room.characterClaims[line.character]) || line.claimedBy || null;
}

module.exports = {
  isNickFree,
  takeOverNick,
  isAuthorized,
  MAX_PASSWORD_ATTEMPTS,
  setRoomPassword,
  checkRoomPassword,
  isPasswordLocked,
  notePasswordFailure,
  isHost,
  isModerator,
  canModerate,
  getLineOwner
};
