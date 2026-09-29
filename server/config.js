// Настройки сервера: папки, лимиты и общий класс ошибки HTTP
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.join(__dirname, '..'); // корень проекта (модули сервера лежат в server/)
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
// Папки можно переопределить переменными окружения (так тесты не трогают рабочие данные)
const UPLOAD_DIR = path.resolve(process.env.DUBLINE_UPLOAD_DIR || path.join(PUBLIC_DIR, 'uploads'));
const PACKS_DIR = path.resolve(process.env.DUBLINE_PACKS_DIR || path.join(PUBLIC_DIR, 'packs'));
const DATA_DIR = path.resolve(process.env.DUBLINE_DATA_DIR || path.join(ROOT_DIR, 'data'));
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

const MAX_PACK_MB = 300;       // размер .zip пака
const MAX_UNPACKED_MB = 1024;  // суммарный размер распакованного пака (защита от zip-бомб)
const MAX_TAKE_MB = 20;        // размер одного дубля
const MAX_SUBTITLE_MB = 20;
const MAX_NICK_LENGTH = 16;
const MAX_CHAT_LENGTH = 500;
const MAX_CHAT_HISTORY = 100;
const CHAT_RATE_LIMIT = { count: 5, windowMs: 5000 };
const VOICE_EFFECTS = ['none', 'robot', 'radio', 'monster', 'thoughts', 'cave', 'behindDoor', 'megaphone'];
const MAX_PITCH = 12;         // полутонов вверх/вниз
const MAX_LATENCY_MS = 1000;  // предел поправки задержки микрофона
const MAX_UNDO_BATCHES = 50;  // сколько последних удалений реплик хранится в корзине сессии
const MAX_TAKE_SHIFT = 30;    // насколько далеко (в секундах) дубль можно утащить от реплики

for (const dir of [UPLOAD_DIR, PACKS_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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
  MAX_UNPACKED_MB,
  MAX_TAKE_MB,
  MAX_SUBTITLE_MB,
  MAX_NICK_LENGTH,
  MAX_CHAT_LENGTH,
  MAX_CHAT_HISTORY,
  CHAT_RATE_LIMIT,
  VOICE_EFFECTS,
  MAX_PITCH,
  MAX_LATENCY_MS,
  MAX_UNDO_BATCHES,
  MAX_TAKE_SHIFT,
  HttpError
};
