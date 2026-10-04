// Server settings: folders, limits and the shared HTTP error class
const fs = require('fs');
const path = require('path');

const requestedPort = Number(process.env.PORT || 3000);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535 ? requestedPort : 3000;
const ROOT_DIR = path.join(__dirname, '..'); // project root (server modules live in server/)
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
// Folders can be overridden with environment variables (so tests never touch real data)
const UPLOAD_DIR = path.resolve(process.env.DUBLINE_UPLOAD_DIR || path.join(PUBLIC_DIR, 'uploads'));
const PACKS_DIR = path.resolve(process.env.DUBLINE_PACKS_DIR || path.join(PUBLIC_DIR, 'packs'));
const DATA_DIR = path.resolve(process.env.DUBLINE_DATA_DIR || path.join(ROOT_DIR, 'data'));
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

const MAX_PACK_MB = 300;       // size of a pack .zip
const MAX_PACK_EXPORT_MB = 384; // estimated uncompressed inputs buffered while exporting
const MAX_EXPORT_LINE_SECONDS = 10 * 60;
const MAX_UNPACKED_MB = 1024;  // total unpacked size of a pack (zip bomb protection)
const MAX_TAKE_MB = 20;        // size of one take
const MAX_SUBTITLE_MB = 20;
const MAX_NICK_LENGTH = 16;
const MAX_CHAT_LENGTH = 500;
const MAX_CHAT_HISTORY = 100;
const CHAT_RATE_LIMIT = { count: 5, windowMs: 5000 };
// Wrong room passwords from all devices together: a new socket per guess must not reset the count
// (a 4-character PIN has only ~1M values), and each check runs scrypt on the server's only thread
const PASSWORD_FAILURE_LIMIT = { count: 20, windowMs: 10 * 60 * 1000 };
const VOICE_EFFECTS = ['none', 'robot', 'radio', 'monster', 'thoughts', 'cave', 'behindDoor', 'megaphone'];
const MAX_PITCH = 12;         // semitones up/down
const MAX_LATENCY_MS = 1000;  // limit of the microphone delay correction
const MAX_UNDO_BATCHES = 50;  // how many recent line deletions the session trash keeps
const MAX_TAKE_SHIFT = 30;    // how far (in seconds) a take can be dragged away from its line

for (const dir of [UPLOAD_DIR, PACKS_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// message is the English text for the log; key/params let the client show it in the player's language
class HttpError extends Error {
  constructor(status, message, key = null, params = {}) {
    super(message);
    this.status = status;
    this.key = key;
    this.params = params;
  }
}

module.exports = {
  PORT,
  ROOT_DIR,
  PUBLIC_DIR,
  UPLOAD_DIR,
  PACKS_DIR,
  ROOMS_FILE,
  MAX_PACK_MB,
  MAX_PACK_EXPORT_MB,
  MAX_EXPORT_LINE_SECONDS,
  MAX_UNPACKED_MB,
  MAX_TAKE_MB,
  MAX_SUBTITLE_MB,
  MAX_NICK_LENGTH,
  MAX_CHAT_LENGTH,
  MAX_CHAT_HISTORY,
  CHAT_RATE_LIMIT,
  PASSWORD_FAILURE_LIMIT,
  VOICE_EFFECTS,
  MAX_PITCH,
  MAX_LATENCY_MS,
  MAX_UNDO_BATCHES,
  MAX_TAKE_SHIFT,
  HttpError
};
