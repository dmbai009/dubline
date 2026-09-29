// Ники, права хоста и пароль комнаты
const crypto = require('crypto');
const { roomSockets } = require('./state');

// Ник закреплен за устройством (clientId), пока его владелец в комнате онлайн.
// Когда владелец вышел, ник можно занять снова — например, после перезапуска туннеля
// (новый адрес = пустой localStorage = новый clientId) или с другого устройства.
function isClientOnline(roomId, clientId, exceptSocketId = null) {
  return Object.entries(roomSockets[roomId] || {})
    .some(([socketId, member]) => socketId !== exceptSocketId && member.clientId === clientId);
}

function isNickFree(room, roomId, nick, clientId, exceptSocketId = null) {
  const owner = room.nickOwners[nick];
  return !owner || owner === clientId || !isClientOnline(roomId, owner, exceptSocketId);
}

// Вернувшийся игрок забирает свой ник, а если это был хост — и права хоста
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
// ПАРОЛЬ КОМНАТЫ И ВЫГНАННЫЕ ИГРОКИ
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
