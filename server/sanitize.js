const path = require('path');
const { MAX_NICK_LENGTH, MAX_CHAT_LENGTH } = require('./config');

// ==========================================
// INPUT SANITIZING
// ==========================================
function sanitizeRoomId(raw) {
  const clean = String(raw || '').trim().replace(/[^a-zA-Z0-9_\-\u0400-\u04FF]/g, '_').slice(0, 40);
  return clean || 'main';
}

function sanitizeNick(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, MAX_NICK_LENGTH);
}

function sanitizePackName(raw) {
  let name = path.basename(String(raw || ''))
    .replace(/[^a-zA-Z0-9_\-\u0400-\u04FF.]/g, '_')
    .replace(/^\.+/, '');
  if (!/\.zip$/i.test(name) || name.length <= 4) return null;
  if (name.length > 120) name = name.slice(0, 116) + '.zip';
  return name;
}

function sanitizeChatText(raw) {
  return String(raw || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_CHAT_LENGTH);
}

module.exports = {
  sanitizeRoomId,
  sanitizeNick,
  sanitizePackName,
  sanitizeChatText
};
