const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const server = http.createServer(app);
// Страница и сокет всегда на одном адресе, поэтому чужим сайтам подключаться не разрешаем
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Папки можно переопределить переменными окружения (так тесты не трогают рабочие данные)
const UPLOAD_DIR = path.resolve(process.env.DUBLINE_UPLOAD_DIR || path.join(PUBLIC_DIR, 'uploads'));
const PACKS_DIR = path.resolve(process.env.DUBLINE_PACKS_DIR || path.join(PUBLIC_DIR, 'packs'));
const DATA_DIR = path.resolve(process.env.DUBLINE_DATA_DIR || path.join(__dirname, 'data'));
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
const MAX_UNDO_BATCHES = 20;  // сколько последних удалений реплик можно отменить
const MAX_TAKE_SHIFT = 30;    // насколько далеко (в секундах) дубль можно утащить от реплики

for (const dir of [UPLOAD_DIR, PACKS_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Медиа паков и дубли не меняются по одному адресу — пусть браузер кэширует их,
// а не перекачивает через туннель при каждой перерисовке
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));
app.use('/packs', express.static(PACKS_DIR));
app.use(express.static(PUBLIC_DIR));
// Mediabunny (MP4-мультиплексор для рендера через WebCodecs) раздаем прямо из node_modules
app.use('/vendor/mediabunny', express.static(path.join(__dirname, 'node_modules', 'mediabunny', 'dist', 'bundles')));
app.use('/vendor/jszip', express.static(path.join(__dirname, 'node_modules', 'jszip', 'dist')));
app.use(express.json());
app.get('/favicon.ico', (req, res) => res.status(204).end());

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ==========================================
// ОЧИСТКА ВХОДНЫХ ДАННЫХ
// ==========================================
function sanitizeRoomId(raw) {
  const clean = String(raw || '').trim().replace(/[^a-zA-Z0-9_\-Ѐ-ӿ]/g, '_').slice(0, 40);
  return clean || 'main';
}

function sanitizeNick(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, MAX_NICK_LENGTH);
}

function sanitizePackName(raw) {
  let name = path.basename(String(raw || ''))
    .replace(/[^a-zA-Z0-9_\-Ѐ-ӿ.]/g, '_')
    .replace(/^\.+/, '');
  if (!/\.zip$/i.test(name) || name.length <= 4) return null;
  if (name.length > 120) name = name.slice(0, 116) + '.zip';
  return name;
}

function sanitizeChatText(raw) {
  return String(raw || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_CHAT_LENGTH);
}

// ==========================================
// КОМНАТЫ (с сохранением на диск)
// ==========================================
// Поля сцены, которые принадлежат сессии (см. раздел «Сессии» ниже)
const SESSION_FIELDS = ['loaded', 'title', 'kind', 'zipUrl', 'videoUrl', 'backingUrl', 'lines', 'characterClaims', 'createdAt', 'updatedAt',
  'audioTracks', 'originalTrack', 'backingTrack', 'baseBackingUrl', 'deletedLines'];
let repairedOnLoad = false;
const rooms = loadRooms();
// Починку таймингов сразу сохраняем, чтобы она выполнялась один раз, а не при каждом запуске
if (repairedOnLoad) writeRoomsNow();
const roomSockets = {}; // { roomId: { socketId: { nick, clientId } } }

function loadRooms() {
  try {
    if (fs.existsSync(ROOMS_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')) || {};
      // После чтения из JSON поля активной сессии и ее запись в sessions — разные объекты; связываем обратно
      for (const room of Object.values(loaded)) {
        const active = room.sessions && room.activeSessionId && room.sessions[room.activeSessionId];
        if (active) SESSION_FIELDS.forEach(field => { room[field] = active[field]; });
        [room, ...Object.values(room.sessions || {})].forEach(repairLineDurations);
        [room, ...Object.values(room.sessions || {})].forEach(cleanImportedCaptions);
        delete room.audioTracksPending; // извлечение дорожек не пережило перезапуск — начнем заново
      }
      return loaded;
    }
  } catch (err) {
    console.error('[Dubline] Не удалось прочитать сохраненные комнаты:', err.message);
  }
  return {};
}

// Сессии, загруженные до исправления: у реплик с MP3/OGG без явного конца стояли 3 секунды.
// Один раз пересчитываем длину по оригинальному голосу.
function repairLineDurations(session) {
  let fixed = 0;
  for (const line of (session && session.lines) || []) {
    if (line.durationChecked || !line.originalAudioUrl) continue;
    line.durationChecked = true;
    repairedOnLoad = true;
    if (Math.abs((line.end - line.start) - 3) > 0.001) continue; // конец был указан в паке
    const file = diskPathForUrl(line.originalAudioUrl);
    if (!file || !fs.existsSync(file)) continue;
    const duration = path.extname(file).toLowerCase() === '.wav' ? getWavDuration(fs.readFileSync(file)) : probeAudioDuration(file);
    if (duration && Math.abs(duration - 3) > 0.05) {
      line.end = Number((line.start + duration).toFixed(2));
      fixed++;
    }
  }
  if (fixed) console.log(`[Dubline] Исправлены длины реплик в «${session.title}»: ${fixed} шт.`);
}

// Сцены, импортированные до исправления разбора ASS: убираем реплики-рисунки (без дублей) и теги \h, \N
function cleanImportedCaptions(session) {
  if (!session || !Array.isArray(session.lines) || session.captionsCleaned) return;
  session.captionsCleaned = true;
  repairedOnLoad = true;
  if (session.kind !== 'custom') return;
  const before = session.lines.length;
  const kept = session.lines.filter(line => line.audioUrl || !isAssDrawing(line.caption || ''));
  kept.forEach(line => { line.caption = cleanAssText(line.caption || ''); });
  if (kept.length !== before) {
    session.lines.splice(0, session.lines.length, ...kept); // тот же массив — связь активной сессии не рвется
    console.log(`[Dubline] Из «${session.title}» убраны реплики-рисунки из субтитров: ${before - kept.length} шт.`);
  }
}

function writeRoomsNow() {
  try {
    Object.values(rooms).forEach(snapshotActive);
    const tmpFile = ROOMS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(rooms));
    fs.renameSync(tmpFile, ROOMS_FILE);
  } catch (err) {
    console.error('[Dubline] Не удалось сохранить комнаты:', err.message);
  }
}

let saveTimer = null;
function saveRooms() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeRoomsNow, 1000);
}

process.on('SIGINT', () => {
  clearTimeout(saveTimer);
  writeRoomsNow();
  process.exit(0);
});

function getRoom(roomId) {
  if (!rooms[roomId]) rooms[roomId] = {};
  const defaults = {
    loaded: false,
    title: '',
    zipUrl: '',
    videoUrl: '',
    backingUrl: '',
    lines: [],
    characterClaims: {},
    host: null,
    hostClientId: null,
    nickOwners: {},
    chat: [],
    latency: {},          // поправка задержки микрофона игроков: ник -> мс
    passwordHash: null,   // пароль комнаты (scrypt), сам пароль не хранится
    passwordSalt: null,
    admitted: [],         // устройства, уже вводившие пароль (повторно не спрашиваем)
    banned: []            // устройства, которых хост выгнал
  };
  for (const key in defaults) {
    if (rooms[roomId][key] === undefined) rooms[roomId][key] = defaults[key];
  }
  const room = rooms[roomId];
  if (!room.sessions) room.sessions = {};
  if (room.activeSessionId === undefined) room.activeSessionId = null;
  // Комнаты из старых версий: текущая сцена становится первой сессией
  if (room.loaded && !room.activeSessionId) {
    room.activeSessionId = newSessionId();
    room.kind = room.zipUrl ? 'pack' : 'custom';
    room.createdAt = room.updatedAt = Date.now();
    snapshotActive(room);
  }
  return room;
}

// ==========================================
// СЕССИИ: в комнате несколько сцен со своими дублями и ролями, активна одна.
// Активная сессия лежит прямо в полях комнаты (с ними работает весь остальной код),
// а room.sessions[id] ссылается на те же массивы.
// ==========================================

function emptySession() {
  return {
    loaded: false, title: '', kind: null, zipUrl: '', videoUrl: '', backingUrl: '', lines: [], characterClaims: {}, createdAt: null, updatedAt: null,
    audioTracks: undefined,   // звуковые дорожки видео отдельными файлами (если их несколько); undefined — еще не проверяли
    originalTrack: 0,         // какая дорожка играет как «Оригинал» (-1 — никакая)
    backingTrack: -1,         // какая дорожка играет как «Интершум» (-1 — родной интершум пака или никакой)
    baseBackingUrl: undefined, // родной интершум пака, к которому возвращаемся при «нет»
    deletedLines: []          // «корзина» удалений хоста для отмены (Ctrl+Z), последние MAX_UNDO_BATCHES
  };
}

function newSessionId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function snapshotActive(room) {
  if (!room.activeSessionId || !room.sessions) return;
  const snapshot = { id: room.activeSessionId };
  SESSION_FIELDS.forEach(field => { snapshot[field] = room[field]; });
  room.sessions[room.activeSessionId] = snapshot;
}

function activateSession(room, id) {
  snapshotActive(room);
  const target = room.sessions[id];
  Object.assign(room, emptySession());
  if (target) SESSION_FIELDS.forEach(field => { room[field] = target[field]; });
  room.activeSessionId = target ? id : null;
}

// Каждый импорт — новая сессия; предыдущие остаются вместе с дублями
function startNewSession(room, fields) {
  snapshotActive(room);
  const now = Date.now();
  room.activeSessionId = newSessionId();
  Object.assign(room, emptySession(), fields, { loaded: true, createdAt: now, updatedAt: now });
  snapshotActive(room);
}

function sessionSummaries(room) {
  snapshotActive(room);
  return Object.values(room.sessions)
    .map(session => ({
      id: session.id,
      title: session.title,
      kind: session.kind,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      total: (session.lines || []).length,
      recorded: (session.lines || []).filter(line => line.audioUrl).length,
      active: session.id === room.activeSessionId
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Папка сцены внутри uploads (pack_… или custom_…), если url указывает на нее
function sceneDirOf(url) {
  const match = /^\/uploads\/([^/]+)\//.exec(decodeURIComponent(url || ''));
  return match && /^(pack_|custom_)/.test(match[1]) ? match[1] : null;
}

// Используется ли папка сцены еще какой-нибудь сессией в любой комнате
function isSceneDirUsed(dir) {
  return Object.values(rooms).some(room => [room, ...Object.values(room.sessions || {})]
    .some(session => sceneDirOf(session.videoUrl) === dir || sceneDirOf(session.backingUrl) === dir));
}

function deleteSessionFiles(session) {
  let takes = 0;
  const trashed = (session.deletedLines || []).flatMap(batch => batch.lines.map(entry => entry.line));
  [...(session.lines || []), ...trashed].forEach(line => {
    if (line.audioUrl) {
      deleteTakeFile(line.audioUrl);
      takes++;
    }
  });
  const dirs = new Set([sceneDirOf(session.videoUrl), sceneDirOf(session.backingUrl)].filter(Boolean));
  dirs.forEach(dir => {
    if (isSceneDirUsed(dir)) return;
    const full = path.join(UPLOAD_DIR, dir);
    if (full.startsWith(UPLOAD_DIR + path.sep)) fs.rm(full, { recursive: true, force: true }, () => {});
  });
  return takes;
}

// Размеры медиафайлов показываем на кнопках скачивания. Кэшируем, чтобы не дергать диск
// на каждую рассылку сессии; неизвестные размеры (файл еще пишется) не кэшируем.
const fileSizeCache = new Map();
const fileHashCache = new Map();

function diskPathForUrl(url) {
  const rel = decodeURIComponent(url).replace(/^\/+/, '');
  const [top, ...rest] = rel.split('/');
  const base = top === 'uploads' ? UPLOAD_DIR : top === 'packs' ? PACKS_DIR : null;
  if (!base) return null;
  const full = path.join(base, ...rest);
  return full.startsWith(base + path.sep) ? full : null;
}

function fileSizeForUrl(url) {
  if (!url) return null;
  if (fileSizeCache.has(url)) return fileSizeCache.get(url);
  try {
    const full = diskPathForUrl(url);
    if (!full) return null;
    const size = fs.statSync(full).size;
    fileSizeCache.set(url, size);
    return size;
  } catch (err) {
    return null;
  }
}

// SHA-256 медиафайла: игроки проверяют им видео, полученное от других игроков по P2P
function fileHashForUrl(url) {
  if (!url) return null;
  if (fileHashCache.has(url)) return fileHashCache.get(url);
  try {
    const full = diskPathForUrl(url);
    if (!full) return null;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    fileHashCache.set(url, hash);
    return hash;
  } catch (err) {
    return null;
  }
}

function forgetFileSizes(...urls) {
  urls.forEach(url => {
    if (!url) return;
    fileSizeCache.delete(url);
    fileHashCache.delete(url);
  });
}

// Секреты (clientId игроков) никогда не уходят клиентам
function publicRoom(room) {
  const { hostClientId, nickOwners, chat, sessions, passwordHash, passwordSalt, admitted, banned, deletedLines, ...rest } = room;
  return {
    ...rest,
    undoCount: (deletedLines || []).length,
    hasPassword: !!room.passwordHash,
    bannedCount: (room.banned || []).length,
    sessionList: sessionSummaries(room),
    videoSize: fileSizeForUrl(room.videoUrl),
    backingSize: fileSizeForUrl(room.backingUrl),
    zipSize: fileSizeForUrl(room.zipUrl),
    videoHash: fileHashForUrl(room.videoUrl),
    backingHash: fileHashForUrl(room.backingUrl)
  };
}

function emitSession(roomId) {
  io.to(roomId).emit('session_updated', publicRoom(getRoom(roomId)));
}

// ==========================================
// ЖУРНАЛ СОБЫТИЙ: консоль сервера + консоль браузера у хоста комнаты
// ==========================================
const DISCONNECT_REASONS = {
  'transport close': 'закрыл вкладку или пропал интернет',
  'ping timeout': 'связь оборвалась (нет ответа от браузера)',
  'transport error': 'ошибка соединения',
  'client namespace disconnect': 'вышел сам',
  'server namespace disconnect': 'отключен сервером',
  'server shutting down': 'сервер выключается'
};

function logEvent(roomId, text, level = 'info') {
  const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  const line = `[${time}] ${roomId ? `[${roomId}] ` : ''}${text}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  const room = roomId && rooms[roomId];
  if (!room || !room.hostClientId) return;
  for (const [socketId, member] of Object.entries(roomSockets[roomId] || {})) {
    if (member.clientId === room.hostClientId) io.to(socketId).emit('host_log', { ts: Date.now(), level, text });
  }
}

function onlineCount(roomId) {
  return new Set(onlineMembers(roomId).map(m => m.clientId)).size;
}

// ==========================================
// СТАТУС ЗАПИСИ И СОВМЕСТНЫЙ ПРОСМОТР (живут только в памяти)
// ==========================================
const recordingNow = {}; // roomId -> { lineId: { nick, socketId } }
const p2pSeeders = {};   // roomId -> { url: Set(socketId) } — у кого из игроков уже есть медиафайл целиком
const watchState = {};   // roomId -> { active, playing, position, at }
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

function deleteTakeFile(url) {
  if (!url || !url.startsWith('/uploads/line_')) return;
  const file = path.join(UPLOAD_DIR, path.basename(decodeURIComponent(url)));
  fs.rm(file, { force: true }, () => {});
}

// ==========================================
// РАЗБОР ПАКОВ (Voxalike / The Choicer Voicer)
// ==========================================
// ==========================================
// ЗВУКОВЫЕ ДОРОЖКИ ВИДЕО (например, японская и русская в одной серии)
// Браузерный плеер играет только одну дорожку, поэтому каждую вытаскиваем отдельным файлом.
// ==========================================
const LANGUAGE_NAMES = { rus: 'Русский', ru: 'Русский', jpn: 'Японский', ja: 'Японский', eng: 'English', en: 'English', ukr: 'Українська', uk: 'Українська', und: '' };

function probeAudioStreams(file) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 20000 });
  const lines = (result.stderr || '').split(/\r?\n/);
  const streams = [];
  let current = null;
  for (const line of lines) {
    const stream = /^\s*Stream #\d+:\d+(?:\[[^\]]*\])?(?:\((\w+)\))?: (\w+): ([^,\s]+)/.exec(line);
    if (stream) {
      current = stream[2] === 'Audio' ? { language: stream[1] || 'und', codec: stream[3], title: '' } : null;
      if (current) streams.push(current);
      continue;
    }
    const title = /^\s+title\s*:\s*(.+)$/.exec(line);
    if (title && current && !current.title) current.title = title[1].trim();
  }
  return streams;
}

const audioTrackJobs = new Map(); // videoUrl -> Promise (чтобы не извлекать одно и то же дважды)

function extractAudioTracks(videoUrl) {
  if (audioTrackJobs.has(videoUrl)) return audioTrackJobs.get(videoUrl);
  const job = (async () => {
    const videoPath = diskPathForUrl(videoUrl);
    if (!videoPath || !fs.existsSync(videoPath)) return [];
    const streams = probeAudioStreams(videoPath);
    if (streams.length < 2) return [];
    const dir = path.dirname(videoPath);
    const dirUrl = videoUrl.slice(0, videoUrl.lastIndexOf('/'));
    const tracks = [];
    for (let i = 0; i < streams.length; i++) {
      const name = `track_${i}.m4a`;
      const out = path.join(dir, name);
      if (!fs.existsSync(out)) {
        const codecArgs = streams[i].codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'];
        await runFfmpeg(['-i', videoPath, '-map', `0:a:${i}`, '-vn', ...codecArgs, '-movflags', '+faststart', out], 'Не удалось извлечь звуковую дорожку');
      }
      const language = streams[i].language;
      tracks.push({
        index: i,
        url: `${dirUrl}/${encodeURIComponent(name)}`,
        language,
        label: streams[i].title || LANGUAGE_NAMES[language] || language,
        codec: streams[i].codec
      });
    }
    return tracks;
  })().catch(err => {
    logEvent(null, `⚠ Звуковые дорожки не извлечены: ${err.message}`, 'warn');
    return [];
  });
  audioTrackJobs.set(videoUrl, job);
  return job;
}

// Если у открытой сессии дорожки еще не проверяли — проверяем в фоне и сообщаем всем, когда готово
function ensureAudioTracks(roomId) {
  const room = getRoom(roomId);
  if (!room.loaded || room.audioTracks !== undefined || !sceneDirOf(room.videoUrl) || room.audioTracksPending) return;
  const sessionId = room.activeSessionId;
  const videoUrl = room.videoUrl;
  room.audioTracksPending = true;
  extractAudioTracks(videoUrl).then(tracks => {
    const target = room.activeSessionId === sessionId ? room : room.sessions[sessionId];
    delete room.audioTracksPending;
    if (!target || target.videoUrl !== videoUrl) return;
    target.audioTracks = tracks;
    if (target.originalTrack === undefined) target.originalTrack = 0;
    if (target.backingTrack === undefined) target.backingTrack = -1;
    if (target.baseBackingUrl === undefined) target.baseBackingUrl = target.backingUrl || '';
    snapshotActive(room);
    saveRooms();
    if (target === room) emitSession(roomId);
    if (tracks.length) logEvent(roomId, `🎧 Найдено звуковых дорожек: ${tracks.length} (${tracks.map(t => t.label).join(', ')})`);
  });
}

// Длина MP3/OGG и прочих форматов: у WAV она есть в заголовке, для остальных спрашиваем ffmpeg.
// Без этого у реплик без явного конца в паке длина молча становилась 3 секунды.
function probeAudioDuration(file) {
  if (!ffmpegPath || !fs.existsSync(file)) return null;
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 10000 });
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(result.stderr || '');
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + parseFloat(match[3]);
  return seconds > 0.05 ? seconds : null;
}

function getWavDuration(buffer) {
  try {
    if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
    const byteRate = buffer.readUInt32LE(28);
    let offset = 36;
    while (offset < buffer.length - 8) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      if (chunkId === 'data') return chunkSize / byteRate;
      offset += 8 + chunkSize;
    }
    return (buffer.length - 44) / byteRate;
  } catch (e) {
    return null;
  }
}

function parseLineContent(content, fileName, fallbackId, originalAudioUrl, audioDuration) {
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  let caption = '';
  const capMatch = content.match(/caption\s*=\s*(.*?)(\r?\n|$)/i);
  if (capMatch) caption = capMatch[1].trim().replace(/^["']|["']$/g, '');

  let character = 'Персонаж';
  const charMatch = content.match(/dub_characters\s*=\s*(.*?)(\r?\n|$)/i);
  if (charMatch) {
    let raw = charMatch[1].trim().replace(/[\[\]"']/g, '');
    if (raw) character = raw.split(',')[0].trim() || 'Персонаж';
  }

  let start = 0;
  let end = 0;
  const timeMatch = content.match(/dub_timestamps\s*=\s*(.*?)(\r?\n|$)/i);
  if (timeMatch) {
    const nums = timeMatch[1].match(/[-+]?[0-9]*\.?[0-9]+/g);
    if (nums && nums.length > 0) {
      start = parseFloat(nums[0]) || 0;
      if (nums.length > 1) {
        end = parseFloat(nums[1]) || start + 3.0;
      } else if (audioDuration) {
        end = start + audioDuration;
      } else {
        end = start + 3.0;
      }
    }
  }

  const numInName = fileName.match(/\d+/);
  const id = numInName ? parseInt(numInName[0], 10) : fallbackId;

  return {
    id,
    character,
    caption,
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2)),
    originalAudioUrl: originalAudioUrl || null,
    claimedBy: null,
    ...emptyTake()
  };
}

// Поля записанного дубля. Эффекты, питч, обрезка и сдвиг не меняют файл — применяются при воспроизведении
function emptyTake() {
  return {
    audioUrl: null,
    audioStart: null,     // когда на таймлайне начинается файл дубля (с учетом ручного сдвига)
    recordedStart: null,  // исходное audioStart сразу после записи (для кнопки «сбросить сдвиг»)
    trimStart: null,      // найденные границы речи внутри файла, в секундах
    trimEnd: null,
    trimEnabled: true,
    effect: 'none',
    pitch: 0,
    recordedBy: null,     // кто записал дубль (чтобы его можно было послушать, даже когда реплика освобождена)
    uploadId: null        // id отправки: повтор той же отправки не сохраняется дважды
  };
}

function parseSeconds(raw) {
  const num = parseFloat(raw);
  return Number.isFinite(num) ? Number(num.toFixed(3)) : null;
}

// Пак распаковывается один раз в uploads/pack_<имя>, повторные запуски используют готовую папку
function readPack(buffer, packName, forceExtract) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new HttpError(400, 'Файл не похож на .zip архив');
  }

  const entries = zip.getEntries().filter(e => !e.isDirectory);
  const unpackedBytes = entries.reduce((sum, e) => sum + (e.header.size || 0), 0);
  if (unpackedBytes > MAX_UNPACKED_MB * 1024 * 1024) {
    throw new HttpError(413, `Распакованный пак больше ${MAX_UNPACKED_MB} МБ`);
  }

  const dirName = 'pack_' + packName.replace(/\.zip$/i, '');
  const targetDir = path.join(UPLOAD_DIR, dirName);
  const readyMarker = path.join(targetDir, '.ready');

  if (forceExtract) fs.rmSync(targetDir, { recursive: true, force: true });
  const needExtract = !fs.existsSync(readyMarker);
  if (needExtract) fs.mkdirSync(targetDir, { recursive: true });

  let videoFile = null;
  let backingFile = null;
  const rawLineFiles = [];
  const audioFilesMap = {};
  const audioByNumber = {};
  const audioDurations = {};

  entries.forEach(entry => {
    // Плоская распаковка: берем только имя файла (защита от "../" в путях архива)
    const name = entry.entryName.split(/[\\/]/).pop();
    if (!name || name.startsWith('.')) return;

    const lower = name.toLowerCase();
    const ext = path.extname(lower);
    const stem = path.basename(lower, ext);
    const isVoice = ['.wav', '.mp3', '.ogg'].includes(ext) && !lower.startsWith('_');
    const isText = (ext === '.ini' || ext === '.txt') && !lower.startsWith('_') && !lower.includes('readme');

    if (lower === 'dub_video.mp4') videoFile = name;
    if (lower.includes('backing_track')) backingFile = name;

    if (!needExtract && !isText && ext !== '.wav') {
      if (isVoice) {
        audioFilesMap[stem] = name;
        const num = (name.match(/\d+/) || [null])[0];
        if (num !== null) audioByNumber[parseInt(num, 10)] = name;
      }
      return;
    }

    const data = entry.getData();
    if (needExtract) fs.writeFileSync(path.join(targetDir, name), data);

    if (isVoice) {
      audioFilesMap[stem] = name;
      const num = (name.match(/\d+/) || [null])[0];
      if (num !== null) audioByNumber[parseInt(num, 10)] = name;

      if (ext === '.wav') {
        const dur = getWavDuration(data);
        if (dur) audioDurations[name] = dur;
      }
    }

    if (isText) {
      const textContent = data.toString('utf8');
      if (/caption|dub_timestamps|dub_characters/i.test(textContent)) {
        rawLineFiles.push({ name, stem, content: textContent });
      }
    }
  });

  if (needExtract) fs.writeFileSync(readyMarker, '');

  // Длины оригинальных голосов в MP3/OGG (для WAV уже прочитаны из заголовка)
  Object.values(audioFilesMap).forEach(name => {
    if (audioDurations[name] === undefined) {
      const duration = probeAudioDuration(path.join(targetDir, name));
      if (duration) audioDurations[name] = duration;
    }
  });

  const urlFor = file => `/uploads/${encodeURIComponent(dirName)}/${encodeURIComponent(file)}`;

  rawLineFiles.sort((a, b) => {
    const numA = (a.name.match(/\d+/) || [0])[0];
    const numB = (b.name.match(/\d+/) || [0])[0];
    return parseInt(numA, 10) - parseInt(numB, 10);
  });

  const lines = rawLineFiles.map((item, idx) => {
    const num = (item.name.match(/\d+/) || [idx + 1])[0];
    const lineId = parseInt(num, 10);
    const matchedAudio = audioFilesMap[item.stem] || audioByNumber[lineId];
    const origUrl = matchedAudio ? urlFor(matchedAudio) : null;
    const dur = matchedAudio ? audioDurations[matchedAudio] : null;

    return parseLineContent(item.content, item.name, lineId, origUrl, dur);
  });

  return {
    title: packName.replace(/\.zip$/i, ''),
    videoUrl: videoFile ? urlFor(videoFile) : '',
    backingUrl: backingFile ? urlFor(backingFile) : '',
    lines
  };
}

function loadPackIntoRoom(roomId, packName, buffer, forceExtract) {
  const room = getRoom(roomId);
  const pack = readPack(buffer, packName, forceExtract);

  // Новый пак — новая сессия: прошлые сессии и их дубли остаются
  startNewSession(room, {
    title: pack.title,
    kind: 'pack',
    zipUrl: `/packs/${encodeURIComponent(packName)}`,
    videoUrl: pack.videoUrl,
    backingUrl: pack.backingUrl,
    lines: pack.lines,
    characterClaims: {}
  });
  forgetFileSizes(room.zipUrl, room.videoUrl, room.backingUrl);
  delete recordingNow[roomId];
  endWatch(roomId, null, '🎬 Совместный просмотр остановлен: сменился пак');
  delete p2pSeeders[roomId];

  saveRooms();
  emitSession(roomId);
  broadcastRecording(roomId);
  ensureAudioTracks(roomId);
  logEvent(roomId, `🎬 Запущен пак «${pack.title}» (${pack.lines.length} реплик)`);
  addSystemMessage(roomId, 'system.packLoaded', { title: pack.title }, `🎬 Хост запустил пак «${pack.title}»`);
  return room;
}

function acceptFile(field, maxMb) {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 }
  }).single(field);

  return (req, res, next) => handler(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      logEvent(null, `⚠ Отклонена загрузка: файл больше ${maxMb} МБ`, 'warn');
      return res.status(413).send(`Файл слишком большой (максимум ${maxMb} МБ)`);
    }
    res.status(400).send('Ошибка загрузки: ' + err.message);
  });
}

function acceptCustomFiles(maxMb) {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024 }
  }).fields([
    { name: 'video', maxCount: 1 },
    { name: 'subtitles', maxCount: 1 }
  ]);

  return (req, res, next) => handler(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      logEvent(null, `⚠ Отклонена загрузка: файл больше ${maxMb} МБ`, 'warn');
      return res.status(413).send(`Файл слишком большой (максимум ${maxMb} МБ)`);
    }
    res.status(400).send('Ошибка загрузки: ' + err.message);
  });
}

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new HttpError(408, `${label}: превышено время обработки`));
    }, 10 * 60 * 1000);
    child.stderr.on('data', chunk => {
      if (stderr.length < 8 * 1024 * 1024) stderr += chunk.toString();
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(new HttpError(500, `${label}: ${err.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ');
      if (detail) console.error(`[Dubline] ${label}: ${detail}`);
      reject(new HttpError(400, label));
    });
  });
}

function findEmbeddedSubtitleMap(filePath) {
  const probe = spawnSync(ffmpegPath, ['-hide_banner', '-i', filePath], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024
  });
  if (probe.error) throw new HttpError(500, `Не удалось проверить MKV: ${probe.error.message}`);
  const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  // Разбираем дорожки субтитров вместе с их названиями (title) и языком
  const tracks = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    const stream = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\((\w+)\))?: (\w+): ([^,\s]+)/.exec(line);
    if (stream) {
      current = stream[3] === 'Subtitle' && /^(ass|ssa|subrip|srt|webvtt)$/i.test(stream[4])
        ? { index: stream[1], language: stream[2] || '', title: '', order: tracks.length }
        : null;
      if (current) tracks.push(current);
      continue;
    }
    const title = /^\s+title\s*:\s*(.+)$/.exec(line);
    if (title && current && !current.title) current.title = title[1].trim();
  }
  if (!tracks.length) return null;

  // В релизах часто несколько дорожек: «Надписи», «Песни», «Полные». Для озвучки нужны реплики
  const score = track => {
    const name = `${track.title} ${track.language}`.toLowerCase();
    let value = 0;
    if (/sign|надпис|song|песн|forced|караоке|karaoke|opening|ending|\bop\b|\bed\b/.test(name)) value -= 10;
    if (/full|полн|dialog|диалог|субтитры/.test(name)) value += 5;
    if (/rus|ru\b|русск/.test(name)) value += 1;
    return value;
  };
  const chosen = [...tracks].sort((a, b) => score(b) - score(a) || a.order - b.order)[0];
  if (tracks.length > 1) {
    logEvent(null, `🔤 В MKV ${tracks.length} дорожки субтитров (${tracks.map(t => t.title || t.language || `#${t.index}`).join(', ')}), выбрана: ${chosen.title || chosen.language || `#${chosen.index}`}`);
  }
  return `0:${chosen.index}`;
}

function isMkvFile(file) {
  return /\.mkv$/i.test(file.originalname || '') || file.mimetype === 'video/x-matroska';
}

function isMp4File(file) {
  return /\.mp4$/i.test(file.originalname || '') || file.mimetype === 'video/mp4';
}

function isSubtitleFile(file) {
  return /\.(ass|ssa|srt|vtt)$/i.test(file.originalname || '');
}

function parseAssTime(str) {
  const parts = String(str || '').trim().split(':');
  if (parts.length < 3) return 0;
  const h = parseFloat(parts[0]) || 0;
  const m = parseFloat(parts[1]) || 0;
  const s = parseFloat(parts[2]) || 0;
  return h * 3600 + m * 60 + s;
}

function parseSrtTime(h, m, s, ms) {
  const hours = parseFloat(h ? h.replace(':', '') : 0) || 0;
  const minutes = parseFloat(m) || 0;
  const seconds = parseFloat(s) || 0;
  const millis = parseFloat(ms) || 0;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

// Строка ASS в режиме рисования ({\p1} и т.п.) или сама похожа на векторные команды «m 0 0 l 157 0…»
function isAssDrawing(rawText) {
  if (/\{[^}]*\\p[1-9]/i.test(rawText)) return true;
  return /^m\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?(\s+[mlbspc]?\s*-?\d+(\.\d+)?)*\s*$/i.test(rawText.replace(/\{[^}]*\}/g, '').trim());
}

// Убираем теги оформления; \N, \n и неразрывный \h превращаем в пробелы
function cleanAssText(rawText) {
  return rawText.replace(/\{[^}]*\}/g, '').replace(/\\[Nnh]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseSubtitles(buffer, fileName) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const ext = path.extname(fileName || '').toLowerCase();
  const lines = [];

  if (ext === '.ass' || ext === '.ssa') {
    const rawLines = text.split(/\r?\n/);
    let formatFields = [];
    let idCounter = 1;

    for (const line of rawLines) {
      const trimmed = line.trim();
      if (/^Format:/i.test(trimmed)) {
        formatFields = trimmed.replace(/^Format:\s*/i, '').split(',').map(s => s.trim().toLowerCase());
      } else if (/^Dialogue:/i.test(trimmed)) {
        const valStr = trimmed.replace(/^Dialogue:\s*/i, '');
        const maxSplits = formatFields.length > 0 ? formatFields.length - 1 : 9;
        const parts = [];
        let curr = valStr;
        for (let i = 0; i < maxSplits; i++) {
          const idx = curr.indexOf(',');
          if (idx === -1) break;
          parts.push(curr.slice(0, idx).trim());
          curr = curr.slice(idx + 1);
        }
        parts.push(curr.trim());

        let start = 0, end = 0, character = 'Персонаж', caption = '';
        if (formatFields.length > 0) {
          const sIdx = formatFields.indexOf('start');
          const eIdx = formatFields.indexOf('end');
          const nIdx = formatFields.indexOf('name');
          const tIdx = formatFields.indexOf('text');
          if (sIdx !== -1 && parts[sIdx]) start = parseAssTime(parts[sIdx]);
          if (eIdx !== -1 && parts[eIdx]) end = parseAssTime(parts[eIdx]);
          if (nIdx !== -1 && parts[nIdx]) character = parts[nIdx] || 'Персонаж';
          if (tIdx !== -1 && parts[tIdx]) caption = parts[tIdx];
        } else {
          start = parseAssTime(parts[1] || '0');
          end = parseAssTime(parts[2] || '0');
          character = parts[4] || 'Персонаж';
          caption = parts[9] || '';
        }

        // Векторные рисунки тайпсеттеров (\p1…) — это не реплики, пропускаем
        if (isAssDrawing(caption)) continue;
        caption = cleanAssText(caption);
        if (caption) {
          lines.push({
            id: idCounter++,
            character: character || 'Персонаж',
            caption,
            start: Number(start.toFixed(2)),
            end: Number(Math.max(start + 0.5, end).toFixed(2)),
            originalAudioUrl: null,
            claimedBy: null,
            ...emptyTake()
          });
        }
      }
    }
  } else {
    // SRT / VTT
    const blocks = text.split(/\r?\n\r?\n+/);
    let idCounter = 1;
    for (const block of blocks) {
      const bLines = block.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (bLines.length < 2) continue;

      let timeLineIdx = bLines.findIndex(l => l.includes('-->'));
      if (timeLineIdx === -1) continue;

      const timeLine = bLines[timeLineIdx];
      const match = timeLine.match(/(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})/);
      if (!match) continue;

      const start = parseSrtTime(match[1], match[2], match[3], match[4]);
      const end = parseSrtTime(match[5], match[6], match[7], match[8]);

      let caption = bLines.slice(timeLineIdx + 1).join(' ').trim();
      caption = caption.replace(/<[^>]+>/g, '').trim();

      let character = 'Персонаж';
      const bracketed = caption.match(/^(?:\[([^\]]+)\]|\(([^)]+)\)):\s*(.*)$/);
      const prefixed = caption.match(/^([A-Za-zА-Яа-яЁёІіЇїЄєҐґ0-9_ .'-]{2,30}):\s*(.*)$/);
      if (bracketed) {
        character = (bracketed[1] || bracketed[2]).trim();
        caption = bracketed[3].trim();
      } else if (prefixed) {
        character = prefixed[1].trim();
        caption = prefixed[2].trim();
      }

      if (caption) {
        lines.push({
          id: idCounter++,
          character,
          caption,
          start: Number(start.toFixed(2)),
          end: Number(Math.max(start + 0.5, end).toFixed(2)),
          originalAudioUrl: null,
          claimedBy: null,
          ...emptyTake()
        });
      }
    }
  }

  return lines;
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    logEvent(null, `⚠ Отклонен запрос (${err.status}): ${err.message}`, 'warn');
    return res.status(err.status).send(err.message);
  }
  logEvent(null, `💥 Ошибка при обработке запроса: ${err.stack || err}`, 'error');
  res.status(500).send('Внутренняя ошибка сервера');
}

// ==========================================
// HTTP API
// ==========================================

// Загрузка ZIP-мода (сохраняется в библиотеку модов). Только для хоста.
app.post('/api/upload-pack', acceptFile('pack', MAX_PACK_MB), (req, res) => {
  try {
    const roomId = sanitizeRoomId(req.query.room);
    const room = getRoom(roomId);

    if (!isHost(room, req.body.clientId)) throw new HttpError(403, 'Менять пак может только хост комнаты');
    if (!req.file) throw new HttpError(400, 'Файл не передан');

    const packName = sanitizePackName(req.file.originalname);
    if (!packName) throw new HttpError(400, 'Нужен .zip архив');

    // Сначала проверяем, что архив читается, и только потом сохраняем его в библиотеку
    const updatedRoom = loadPackIntoRoom(roomId, packName, req.file.buffer, true);
    fs.writeFileSync(path.join(PACKS_DIR, packName), req.file.buffer);
    // Архив записан только что — разошлем сессию еще раз уже с его размером
    forgetFileSizes(updatedRoom.zipUrl);
    emitSession(roomId);

    console.log(`[Dubline] Загружен мод [${packName}] в комнату [${roomId}]`);
    res.json({ success: true, session: publicRoom(updatedRoom) });
  } catch (err) {
    sendError(res, err);
  }
});

// Список сохраненных модов на сервере
app.get('/api/server-packs', (req, res) => {
  try {
    const files = fs.readdirSync(PACKS_DIR).filter(f => f.toLowerCase().endsWith('.zip'));
    const list = files.map(file => {
      const stats = fs.statSync(path.join(PACKS_DIR, file));
      return {
        filename: file,
        title: file.replace(/\.zip$/i, ''),
        sizeMb: (stats.size / (1024 * 1024)).toFixed(1),
        url: `/packs/${encodeURIComponent(file)}`
      };
    });
    res.json(list);
  } catch (err) {
    res.status(500).json([]);
  }
});

// Загрузить в комнату мод, уже сохраненный на сервере. Только для хоста.
app.post('/api/load-server-pack', (req, res) => {
  try {
    const { filename, room, clientId } = req.body;
    const roomId = sanitizeRoomId(room);
    if (!isHost(getRoom(roomId), clientId)) throw new HttpError(403, 'Менять пак может только хост комнаты');

    const packName = sanitizePackName(filename);
    if (!packName || packName !== filename) throw new HttpError(400, 'Некорректное имя мода');

    const filePath = path.join(PACKS_DIR, packName);
    if (!fs.existsSync(filePath)) throw new HttpError(404, 'Мод не найден на сервере');

    const updatedRoom = loadPackIntoRoom(roomId, packName, fs.readFileSync(filePath), false);
    res.json({ success: true, session: publicRoom(updatedRoom) });
  } catch (err) {
    sendError(res, err);
  }
});

// Раздельная загрузка Видео (.mp4) + Субтитров (.ass / .srt / .vtt)
app.post('/api/upload-custom', acceptCustomFiles(MAX_PACK_MB), async (req, res) => {
  let targetDir = null;
  try {
    const roomId = sanitizeRoomId(req.query.room);
    const room = getRoom(roomId);
    if (!isHost(room, req.body.clientId)) throw new HttpError(403, 'Создавать сцену может только хост комнаты');

    const videoFile = req.files && req.files['video'] ? req.files['video'][0] : null;
    const subFile = req.files && req.files['subtitles'] ? req.files['subtitles'][0] : null;

    if (!videoFile) throw new HttpError(400, 'Не передан видеофайл (.mp4 / .mkv)');
    if (!isMp4File(videoFile) && !isMkvFile(videoFile)) throw new HttpError(400, 'Поддерживаются только видео .mp4 и .mkv');
    if (subFile && !isSubtitleFile(subFile)) throw new HttpError(400, 'Поддерживаются субтитры .ass, .ssa, .srt и .vtt');
    if (subFile && subFile.size > MAX_SUBTITLE_MB * 1024 * 1024) throw new HttpError(413, `Субтитры больше ${MAX_SUBTITLE_MB} МБ`);

    const customTitle = String(req.body.title || path.basename(videoFile.originalname, path.extname(videoFile.originalname)))
      .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Custom_Scene';

    const dirName = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    targetDir = path.join(UPLOAD_DIR, dirName);
    fs.mkdirSync(targetDir, { recursive: true });

    const videoName = 'dub_video.mp4';
    const videoPath = path.join(targetDir, videoName);
    let subtitleBuffer = subFile ? subFile.buffer : null;
    let subtitleName = subFile ? subFile.originalname : '';

    if (isMkvFile(videoFile)) {
      const mkvPath = path.join(targetDir, 'source.mkv');
      fs.writeFileSync(mkvPath, videoFile.buffer);

      if (!subtitleBuffer) {
        const extractedPath = path.join(targetDir, 'embedded.ass');
        const subtitleMap = findEmbeddedSubtitleMap(mkvPath);
        if (!subtitleMap) throw new HttpError(400, 'В MKV нет встроенных субтитров ASS/SSA/SRT');
        try {
          await runFfmpeg(['-i', mkvPath, '-map', subtitleMap, '-c:s', 'ass', extractedPath], 'Не удалось извлечь встроенные субтитры');
          subtitleBuffer = fs.readFileSync(extractedPath);
          subtitleName = 'embedded.ass';
          if (subtitleBuffer.length > MAX_SUBTITLE_MB * 1024 * 1024) throw new HttpError(413, `Встроенные субтитры больше ${MAX_SUBTITLE_MB} МБ`);
        } finally {
          fs.rmSync(extractedPath, { force: true });
        }
      }

      try {
        await runFfmpeg(['-i', mkvPath, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', videoPath], 'Не удалось ремуксить MKV в MP4');
      } catch (copyError) {
        await runFfmpeg(['-i', mkvPath, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', videoPath], 'Не удалось ремуксить MKV в MP4 с AAC-аудио');
      } finally {
        fs.rmSync(mkvPath, { force: true });
      }
    } else {
      fs.writeFileSync(videoPath, videoFile.buffer);
    }

    if (!subtitleBuffer) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      throw new HttpError(400, 'Передайте файл субтитров или MKV со встроенной дорожкой субтитров');
    }

    const lines = parseSubtitles(subtitleBuffer, subtitleName);
    if (!lines.length) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      throw new HttpError(400, 'В файле субтитров не найдено реплик');
    }

    startNewSession(room, {
      title: customTitle,
      kind: 'custom',
      zipUrl: '',
      videoUrl: `/uploads/${encodeURIComponent(dirName)}/${encodeURIComponent(videoName)}`,
      backingUrl: '',
      lines,
      characterClaims: {}
    });
    forgetFileSizes(room.videoUrl);
    delete recordingNow[roomId];
    endWatch(roomId, null, '🎬 Совместный просмотр остановлен: сменилась сцена');
    delete p2pSeeders[roomId];

    saveRooms();
    emitSession(roomId);
    broadcastRecording(roomId);
    ensureAudioTracks(roomId);
    addSystemMessage(roomId, 'system.customScene', { title: customTitle, count: lines.length }, `🎬 Хост создал новую сцену «${customTitle}» (${lines.length} реплик)`);
    console.log(`[Dubline] Создана пользовательская сцена [${customTitle}] (${lines.length} реплик) в комнате [${roomId}]`);
    res.json({ success: true, session: publicRoom(room) });
  } catch (err) {
    if (targetDir) fs.rmSync(targetDir, { recursive: true, force: true });
    sendError(res, err);
  }
});

// Загрузка дубля
app.post('/api/upload-line-audio', acceptFile('audio', MAX_TAKE_MB), (req, res) => {
  try {
    const roomId = sanitizeRoomId(req.query.room);
    const room = getRoom(roomId);

    const lineId = parseInt(req.body.lineId, 10);
    const userName = sanitizeNick(req.body.userName);
    const audioStart = parseSeconds(req.body.audioStart);
    const trimStart = parseSeconds(req.body.trimStart);
    const trimEnd = parseSeconds(req.body.trimEnd);

    const uploadId = String(req.body.uploadId || '').slice(0, 64);
    const sessionId = String(req.body.sessionId || '');

    if (!req.file || !lineId) throw new HttpError(400, 'Некорректные данные');
    if (!isAuthorized(room, userName, req.body.clientId)) throw new HttpError(403, 'Ник не подтвержден — перезайдите в комнату');

    // Дубль мог прийти с задержкой (повторная отправка после обрыва связи): кладем его в ту сессию,
    // где он был записан, даже если хост уже переключился на другую
    snapshotActive(room);
    const isActiveSession = !sessionId || sessionId === room.activeSessionId;
    const target = isActiveSession ? room : room.sessions[sessionId];
    if (!target) throw new HttpError(410, 'Сессия, в которой записан дубль, уже удалена');

    const line = target.lines.find(l => l.id === lineId);
    if (!line) throw new HttpError(404, 'Реплика не найдена');

    // Повтор той же отправки (ответ сервера потерялся) — второй раз не сохраняем
    if (uploadId && line.uploadId === uploadId && line.audioUrl) {
      return res.json({ success: true, audioUrl: line.audioUrl, audioStart: line.audioStart, duplicate: true });
    }

    const owner = target.characterClaims[line.character] || line.claimedBy || null;
    if (owner !== userName) throw new HttpError(403, 'Реплика занята другим игроком');

    const fileName = `line_${roomId}_${lineId}_${Date.now()}.webm`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fileName), req.file.buffer);

    deleteTakeFile(line.audioUrl);
    line.audioUrl = `/uploads/${encodeURIComponent(fileName)}`;
    line.audioStart = audioStart !== null ? Math.max(0, audioStart) : line.start;
    line.recordedStart = line.audioStart;
    line.recordedBy = userName;
    line.uploadId = uploadId || null;
    target.updatedAt = Date.now();
    // Выбранный голос (эффект/питч) переживает перезапись дубля
    const hasTrim = trimStart !== null && trimEnd !== null && trimStart >= 0 && trimEnd > trimStart;
    line.trimStart = hasTrim ? trimStart : null;
    line.trimEnd = hasTrim ? trimEnd : null;
    if (line.trimEnabled === undefined) line.trimEnabled = true;
    if (!line.effect) line.effect = 'none';
    if (!line.pitch) line.pitch = 0;

    saveRooms();
    if (isActiveSession) io.to(roomId).emit('line_updated', line);
    else emitSession(roomId); // дубль ушел в неактивную сессию — обновим только ее прогресс в списке
    logEvent(roomId, `💾 ${userName} сохранил дубль реплики #${lineId} (${Math.round(req.file.size / 1024)} КБ)${isActiveSession ? '' : ` в сессию «${target.title}»`}`);
    res.json({ success: true, audioUrl: line.audioUrl, audioStart: line.audioStart });
  } catch (err) {
    sendError(res, err);
  }
});

// Удаление дубля (стереть неудачную запись)
app.post('/api/delete-line-audio', (req, res) => {
  try {
    const { lineId, userName, clientId } = req.body;
    const roomId = sanitizeRoomId(req.body.room);
    const room = getRoom(roomId);

    const line = room.lines.find(l => l.id === parseInt(lineId, 10));
    if (!line) throw new HttpError(404, 'Реплика не найдена');

    const nick = sanitizeNick(userName);
    const owner = getLineOwner(room, line);
    if (!isAuthorized(room, nick, clientId) || (owner && owner !== nick)) {
      throw new HttpError(403, 'Нельзя удалить чужой дубль');
    }

    deleteTakeFile(line.audioUrl);
    const { effect, pitch, trimEnabled } = line;
    Object.assign(line, emptyTake(), { effect: effect || 'none', pitch: pitch || 0, trimEnabled: trimEnabled !== false });

    saveRooms();
    io.to(roomId).emit('line_updated', line);
    logEvent(roomId, `🗑 ${nick} удалил дубль реплики #${line.id}`);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ==========================================
// WEBSOCKETS
// ==========================================
io.on('connection', socket => {
  let roomId = null;
  let nick = '';
  let clientId = '';
  let chatTimestamps = [];
  let passwordAttempts = 0;

  function leaveCurrentRoom(reason) {
    if (roomId && roomSockets[roomId] && roomSockets[roomId][socket.id]) {
      const room = getRoom(roomId);
      const wasHost = isHost(room, clientId);
      delete roomSockets[roomId][socket.id];
      socket.leave(roomId);
      if (clearSocketRecordings(roomId, socket.id)) broadcastRecording(roomId);
      if (clearSocketSeeds(roomId, socket.id)) broadcastSeeders(roomId);
      broadcastRoomUsers(roomId);

      const why = typeof reason === 'string' ? ` — ${DISCONNECT_REASONS[reason] || reason}` : '';
      logEvent(roomId, `← ${nick || 'игрок без ника'} вышел${why}. Онлайн: ${onlineCount(roomId)}`, reason === 'ping timeout' || reason === 'transport error' ? 'warn' : 'info');

      // Хост ушел совсем — совместный просмотр заканчивается
      if (wasHost && !isHostOnline(roomId)) endWatch(roomId, nick, '🎬 Совместный просмотр остановлен: хост вышел');
    }
  }

  function renameClaims(room, oldName, newName) {
    for (const char in room.characterClaims) {
      if (room.characterClaims[char] === oldName) room.characterClaims[char] = newName;
    }
    room.lines.forEach(l => {
      if (l.claimedBy === oldName) l.claimedBy = newName;
      if (l.recordedBy === oldName) l.recordedBy = newName;
    });
    if (room.latency[oldName] !== undefined && room.latency[newName] === undefined) {
      room.latency[newName] = room.latency[oldName];
      delete room.latency[oldName];
    }
  }

  socket.on('join_room', (data = {}) => {
    const nextClientId = String(data.clientId || '').slice(0, 64);
    if (!nextClientId) return;

    const nextRoomId = sanitizeRoomId(data.room);
    const candidateRoom = getRoom(nextRoomId);
    const isRoomHost = candidateRoom.hostClientId === nextClientId;

    // Выгнанных не пускаем; в запароленную комнату — только с верным паролем (один раз на устройство)
    if (!isRoomHost && candidateRoom.banned.includes(nextClientId)) {
      logEvent(nextRoomId, '⛔ Выгнанный игрок пытался вернуться', 'warn');
      return socket.emit('join_denied', { reason: 'banned' });
    }
    if (!isRoomHost && candidateRoom.passwordHash && !candidateRoom.admitted.includes(nextClientId)) {
      if (passwordAttempts >= MAX_PASSWORD_ATTEMPTS) return socket.emit('join_denied', { reason: 'tooMany' });
      if (!data.password) return socket.emit('join_denied', { reason: 'password' });
      if (!checkRoomPassword(candidateRoom, data.password)) {
        passwordAttempts++;
        logEvent(nextRoomId, `⚠ Неверный пароль комнаты (попытка ${passwordAttempts} из ${MAX_PASSWORD_ATTEMPTS})`, 'warn');
        return socket.emit('join_denied', { reason: passwordAttempts >= MAX_PASSWORD_ATTEMPTS ? 'tooMany' : 'wrongPassword' });
      }
      candidateRoom.admitted.push(nextClientId);
    }

    if (roomId && roomId !== nextRoomId) leaveCurrentRoom();

    roomId = nextRoomId;
    clientId = nextClientId;
    const room = candidateRoom;

    let requested = sanitizeNick(data.nick);
    const previousOwner = requested ? room.nickOwners[requested] : null;
    let error = null;
    let errorKey = null;
    let errorParams = null;
    if (requested && !isNickFree(room, roomId, requested, clientId, socket.id)) {
      error = `Ник «${requested}» уже занят другим игроком в этой комнате`;
      errorKey = 'error.nickTaken';
      errorParams = { nick: requested };
      requested = '';
    }
    nick = requested;
    if (nick) takeOverNick(room, roomId, nick, clientId, socket.id);

    // Первый зашедший в комнату становится хостом
    if (!room.hostClientId) room.hostClientId = clientId;
    if (room.hostClientId === clientId && nick) room.host = nick;

    socket.join(roomId);
    if (!roomSockets[roomId]) roomSockets[roomId] = {};
    roomSockets[roomId][socket.id] = { nick, clientId };

    saveRooms();
    socket.emit('nick_state', { nick, error, errorKey, errorParams });
    ensureAudioTracks(roomId);
    socket.emit('session_updated', publicRoom(room));
    socket.emit('chat_history', room.chat);
    socket.emit('recording_state', recordingList(roomId));
    socket.emit('p2p_seeders', seedersSummary(roomId));
    // Актуальное состояние просмотра: подхватить идущий или сбросить зависший
    if (watchState[roomId]) socket.emit('watch_sync', watchState[roomId]);
    else socket.emit('watch_stop', {});
    broadcastRoomUsers(roomId);

    const who = nick || 'игрок без ника';
    const returned = nick && previousOwner && previousOwner !== clientId ? ' (вернулся с нового адреса/устройства)' : '';
    if (error) logEvent(roomId, `⚠ Кто-то пытался зайти под занятым ником «${sanitizeNick(data.nick)}»`, 'warn');
    logEvent(roomId, `→ ${who} зашел${returned}. Онлайн: ${onlineCount(roomId)}`);
  });

  socket.on('rename_user', (data = {}) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const newName = sanitizeNick(data.newName);
    if (!newName || newName === nick) return socket.emit('nick_state', { nick });

    if (!isNickFree(room, roomId, newName, clientId, socket.id)) {
      return socket.emit('nick_state', {
        nick,
        error: `Ник «${newName}» уже занят другим игроком`,
        errorKey: 'error.nickTaken',
        errorParams: { nick: newName }
      });
    }

    const oldName = nick;
    if (oldName && room.nickOwners[oldName] === clientId) delete room.nickOwners[oldName];
    takeOverNick(room, roomId, newName, clientId, socket.id);
    nick = newName;
    roomSockets[roomId][socket.id].nick = newName;

    if (oldName) renameClaims(room, oldName, newName);
    if (room.hostClientId === clientId) room.host = newName;
    logEvent(roomId, `✎ ${oldName || 'игрок без ника'} теперь ${newName}`);

    saveRooms();
    socket.emit('nick_state', { nick });
    emitSession(roomId);
    broadcastRoomUsers(roomId);
  });

  socket.on('claim_character', ({ character } = {}) => {
    if (!roomId || !nick) return;
    const room = getRoom(roomId);
    if (room.characterClaims[character]) return;

    room.characterClaims[character] = nick;
    room.lines.forEach(l => {
      if (l.character === character) l.claimedBy = nick;
    });
    saveRooms();
    emitSession(roomId);
  });

  // Снять роль может ее владелец или хост
  socket.on('unclaim_character', ({ character } = {}) => {
    if (!roomId || !nick) return;
    const room = getRoom(roomId);
    const owner = room.characterClaims[character];
    if (!owner || (owner !== nick && !isHost(room, clientId))) return;

    delete room.characterClaims[character];
    room.lines.forEach(l => {
      if (l.character === character && l.claimedBy === owner) l.claimedBy = null;
    });
    saveRooms();
    emitSession(roomId);
    if (owner !== nick) addSystemMessage(roomId, 'system.roleReleased', { character, owner }, `👑 Хост снял роль «${character}» с игрока ${owner}`);
  });

  socket.on('claim_line', ({ lineId } = {}) => {
    if (!roomId || !nick) return;
    const room = getRoom(roomId);
    const line = room.lines.find(l => l.id === lineId);
    if (!line) return;

    const charOwner = room.characterClaims[line.character];
    if (charOwner && charOwner !== nick) return;
    if (!line.claimedBy || line.claimedBy === nick) {
      line.claimedBy = nick;
      saveRooms();
      io.to(roomId).emit('line_updated', line);
    }
  });

  socket.on('unclaim_line', ({ lineId } = {}) => {
    if (!roomId || !nick) return;
    const room = getRoom(roomId);
    const line = room.lines.find(l => l.id === lineId);
    if (!line || !line.claimedBy) return;
    if (room.characterClaims[line.character]) return;

    const owner = line.claimedBy;
    if (owner !== nick && !isHost(room, clientId)) return;

    line.claimedBy = null;
    saveRooms();
    io.to(roomId).emit('line_updated', line);
    if (owner !== nick) addSystemMessage(roomId, 'system.lineReleased', { id: line.id, owner }, `👑 Хост освободил реплику #${line.id} игрока ${owner}`);
  });

  // Настройки своего дубля: эффект, питч, обрезка тишины, ручной сдвиг по таймлайну
  socket.on('set_take_props', (data = {}) => {
    if (!roomId || !nick) return;
    const room = getRoom(roomId);
    const line = room.lines.find(l => l.id === data.lineId);
    if (!line || getLineOwner(room, line) !== nick) return;

    if (VOICE_EFFECTS.includes(data.effect)) line.effect = data.effect;
    if (data.pitch !== undefined) {
      const pitch = Math.round(Number(data.pitch));
      if (Number.isFinite(pitch)) line.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
    }
    if (typeof data.trimEnabled === 'boolean') line.trimEnabled = data.trimEnabled;
    if (data.audioStart !== undefined && line.audioUrl) {
      const start = parseSeconds(data.audioStart);
      if (start !== null) {
        const min = Math.max(0, line.start - MAX_TAKE_SHIFT);
        line.audioStart = Number(Math.max(min, Math.min(line.start + MAX_TAKE_SHIFT, start)).toFixed(3));
      }
    }

    saveRooms();
    io.to(roomId).emit('line_updated', line);
  });

  // ---------- Права хоста ----------
  socket.on('host_reset_claims', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, clientId)) return;

    room.characterClaims = {};
    room.lines.forEach(l => { l.claimedBy = null; });
    saveRooms();
    emitSession(roomId);
    addSystemMessage(roomId, 'system.claimsReset', {}, '♻️ Хост сбросил все роли и реплики (записанные дубли сохранены)');
  });

  socket.on('host_force_pause', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, clientId)) return;

    io.to(roomId).emit('force_pause', { by: nick });
    logEvent(roomId, `⏸ ${nick} поставил паузу у всех`);
    addSystemMessage(roomId, 'system.forcePause', { nick }, `⏸ Хост ${nick} поставил видео на паузу у всех`);
  });

  // Если хост ушел, любой игрок может забрать права себе
  socket.on('claim_host', () => {
    if (!roomId || !nick) return;
    const room = getRoom(roomId);
    if (isHostOnline(roomId)) return;

    room.hostClientId = clientId;
    room.host = nick;
    saveRooms();
    broadcastRoomUsers(roomId);
    logEvent(roomId, `👑 ${nick} стал хостом`);
    addSystemMessage(roomId, 'system.newHost', { nick }, `👑 ${nick} теперь хост комнаты`);
  });

  // ---------- Чат ----------
  socket.on('chat_message', ({ text } = {}) => {
    if (!roomId || !nick) return;
    const clean = sanitizeChatText(text);
    if (!clean) return;

    const now = Date.now();
    chatTimestamps = chatTimestamps.filter(t => now - t < CHAT_RATE_LIMIT.windowMs);
    if (chatTimestamps.length >= CHAT_RATE_LIMIT.count) return;
    chatTimestamps.push(now);

    addChatMessage(roomId, { nick, text: clean });
  });

  // ---------- Пароль комнаты и выгнанные (управляет хост) ----------
  socket.on('host_set_password', ({ password } = {}) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, clientId)) return;
    const clean = String(password || '').slice(0, 64);
    setRoomPassword(room, clean);
    // Все, кто уже в комнате, остаются: их устройства считаем допущенными
    if (clean) room.admitted = [...new Set(onlineMembers(roomId).map(m => m.clientId))];
    saveRooms();
    emitSession(roomId);
    if (clean) {
      addSystemMessage(roomId, 'system.passwordSet', { nick }, `🔒 ${nick} поставил пароль на комнату`);
      logEvent(roomId, `🔒 ${nick} поставил пароль на комнату`);
    } else {
      addSystemMessage(roomId, 'system.passwordRemoved', { nick }, `🔓 ${nick} убрал пароль комнаты`);
      logEvent(roomId, `🔓 ${nick} убрал пароль комнаты`);
    }
  });

  socket.on('host_kick', ({ nick: target } = {}) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const victim = sanitizeNick(target);
    if (!isHost(room, clientId) || !victim || victim === nick) return;

    const victims = Object.entries(roomSockets[roomId] || {}).filter(([, member]) => member.nick === victim);
    const ids = new Set(victims.map(([, member]) => member.clientId));
    if (room.nickOwners[victim]) ids.add(room.nickOwners[victim]);
    ids.delete(room.hostClientId);
    if (!ids.size) return;

    room.banned = [...new Set([...room.banned, ...ids])];
    room.admitted = room.admitted.filter(id => !ids.has(id));
    delete room.nickOwners[victim];
    saveRooms();

    victims.forEach(([socketId]) => {
      const target = io.sockets.sockets.get(socketId);
      if (target) {
        target.emit('kicked', { by: nick });
        target.disconnect(true);
      }
    });
    emitSession(roomId);
    addSystemMessage(roomId, 'system.kicked', { nick: victim }, `⛔ ${victim} удален из комнаты`);
    logEvent(roomId, `⛔ ${nick} выгнал ${victim}`);
  });

  socket.on('host_unban_all', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, clientId) || !room.banned.length) return;
    const count = room.banned.length;
    room.banned = [];
    saveRooms();
    emitSession(roomId);
    logEvent(roomId, `✅ ${nick} разрешил вернуться выгнанным (${count})`);
  });

  // ---------- Сессии (управляет хост) ----------
  function resetSceneState(reason) {
    delete recordingNow[roomId];
    endWatch(roomId, null, reason);
    delete p2pSeeders[roomId];
    broadcastRecording(roomId);
    broadcastSeeders(roomId);
  }

  socket.on('host_switch_session', ({ id } = {}) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, clientId) || !room.sessions[id] || id === room.activeSessionId) return;
    activateSession(room, id);
    resetSceneState('🎬 Совместный просмотр остановлен: сменилась сессия');
    ensureAudioTracks(roomId);
    saveRooms();
    emitSession(roomId);
    addSystemMessage(roomId, 'system.sessionSwitched', { nick, title: room.title }, `🎬 ${nick} открыл сессию «${room.title}»`);
    logEvent(roomId, `🎬 ${nick} открыл сессию «${room.title}»`);
  });

  socket.on('host_rename_session', ({ id, title } = {}) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const clean = sanitizeChatText(title).slice(0, 80);
    if (!isHost(room, clientId) || !room.sessions[id] || !clean) return;
    if (id === room.activeSessionId) room.title = clean;
    room.sessions[id].title = clean;
    snapshotActive(room);
    saveRooms();
    emitSession(roomId);
    logEvent(roomId, `✎ Сессия переименована: «${clean}»`);
  });

  socket.on('host_delete_session', ({ id } = {}) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, clientId) || !room.sessions[id]) return;
    snapshotActive(room);
    const doomed = room.sessions[id];

    if (id === room.activeSessionId) {
      // Удаляем открытую — переходим на самую свежую из оставшихся (или на пустую комнату)
      room.activeSessionId = null;
      const next = Object.values(room.sessions)
        .filter(session => session.id !== id)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      if (next) activateSession(room, next.id);
      else Object.assign(room, emptySession());
      resetSceneState('🎬 Совместный просмотр остановлен: сессия удалена');
    }
    delete room.sessions[id];
    const takes = deleteSessionFiles(doomed);

    saveRooms();
    emitSession(roomId);
    addSystemMessage(roomId, 'system.sessionDeleted', { nick, title: doomed.title, takes }, `🗑 ${nick} удалил сессию «${doomed.title}» (${takes} дублей)`);
    logEvent(roomId, `🗑 ${nick} удалил сессию «${doomed.title}» и ее файлы (${takes} дублей)`);
  });

  // ---------- Звуковые дорожки: что играет как оригинал и как интершум (выбирает хост) ----------
  socket.on('host_set_audio_tracks', ({ original, backing } = {}) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const tracks = room.audioTracks || [];
    if (!isHost(room, clientId) || !tracks.length) return;
    const valid = value => Number.isInteger(value) && value >= -1 && value < tracks.length;
    if (valid(original)) room.originalTrack = original;
    if (valid(backing)) room.backingTrack = backing;
    if (room.baseBackingUrl === undefined) room.baseBackingUrl = room.backingUrl || '';
    room.backingUrl = room.backingTrack >= 0 ? tracks[room.backingTrack].url : room.baseBackingUrl;
    snapshotActive(room);
    saveRooms();
    emitSession(roomId);
    const name = index => (index >= 0 ? tracks[index].label || `#${index + 1}` : 'нет');
    logEvent(roomId, `🎧 ${nick}: оригинал — ${name(room.originalTrack)}, интершум — ${name(room.backingTrack)}`);
  });

  // ---------- Персонажи реплик: перенос на другую дорожку ----------
  // Все могут переносить свои и свободные реплики; хост — любые, в том числе в чужие роли
  function canMoveLine(room, line, name, host) {
    if (host) return true;
    const owner = getLineOwner(room, line);
    if (owner && owner !== nick) return false;
    const roleOwner = room.characterClaims[name];
    return !roleOwner || roleOwner === nick;
  }

  function moveLine(room, line, name) {
    const oldName = line.character;
    if (oldName === name) return false;
    // Если реплика принадлежала игроку через роль, сохраняем владельца явно
    if (!line.claimedBy && room.characterClaims[oldName]) line.claimedBy = room.characterClaims[oldName];
    line.character = name;
    return true;
  }

  function dropEmptyRoleClaims(room) {
    for (const character of Object.keys(room.characterClaims)) {
      if (!room.lines.some(l => l.character === character)) delete room.characterClaims[character];
    }
  }

  function cleanCharacterName(raw) {
    return sanitizeChatText(raw).slice(0, 40);
  }

  socket.on('set_line_character', ({ lineId, character } = {}) => {
    if (!roomId || !nick) return;
    const room = getRoom(roomId);
    const line = room.lines.find(l => l.id === lineId);
    const name = cleanCharacterName(character);
    if (!line || !name || !canMoveLine(room, line, name, isHost(room, clientId))) return;
    const oldName = line.character;
    if (!moveLine(room, line, name)) return;
    dropEmptyRoleClaims(room);
    saveRooms();
    emitSession(roomId);
    logEvent(roomId, `✎ ${nick}: реплика #${line.id} — «${oldName}» → «${name}»`);
  });

  // Несколько выделенных реплик разом; недоступные пропускаем и сообщаем сколько
  socket.on('set_lines_character', ({ lineIds, character } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!roomId || !nick || !Array.isArray(lineIds)) return reply({ moved: 0, skipped: 0 });
    const room = getRoom(roomId);
    const name = cleanCharacterName(character);
    if (!name) return reply({ moved: 0, skipped: lineIds.length });
    const host = isHost(room, clientId);
    let moved = 0;
    let skipped = 0;
    for (const id of lineIds.slice(0, 2000)) {
      const line = room.lines.find(l => l.id === id);
      if (!line) continue;
      if (!canMoveLine(room, line, name, host)) { skipped++; continue; }
      if (moveLine(room, line, name)) moved++;
    }
    if (moved) {
      dropEmptyRoleClaims(room);
      saveRooms();
      emitSession(roomId);
      logEvent(roomId, `✎ ${nick}: ${moved} реплик → «${name}»${skipped ? ` (пропущено ${skipped})` : ''}`);
    }
    reply({ moved, skipped });
  });

  // Переименовать дорожку целиком (все реплики персонажа); с существующим именем — слияние
  socket.on('rename_character', ({ from, to } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!roomId || !nick) return reply({ ok: false });
    const room = getRoom(roomId);
    const name = cleanCharacterName(to);
    const lines = room.lines.filter(l => l.character === from);
    if (!name || !lines.length || name === from) return reply({ ok: false });
    const host = isHost(room, clientId);
    if (!host && !lines.every(line => canMoveLine(room, line, name, false))) return reply({ ok: false, reason: 'denied' });

    const roleOwner = room.characterClaims[from];
    lines.forEach(line => { line.character = name; });
    // Занятая роль переезжает вместе с дорожкой, если новое имя свободно
    if (roleOwner && !room.characterClaims[name]) room.characterClaims[name] = roleOwner;
    delete room.characterClaims[from];
    if (roleOwner && room.characterClaims[name] !== roleOwner) lines.forEach(line => { if (!line.claimedBy) line.claimedBy = roleOwner; });
    dropEmptyRoleClaims(room);
    saveRooms();
    emitSession(roomId);
    logEvent(roomId, `✎ ${nick}: дорожка «${from}» → «${name}» (${lines.length} реплик)`);
    reply({ ok: true, moved: lines.length });
  });

  // Хост удаляет выбранные реплики (например, надписи на экране, которые не нужно озвучивать)
  socket.on('host_delete_lines', ({ lineIds } = {}) => {
    if (!roomId || !Array.isArray(lineIds)) return;
    const room = getRoom(roomId);
    if (!isHost(room, clientId)) return;
    const doomed = new Set(lineIds);
    // Запоминаем, где стояли реплики, чтобы отмена вернула их на место
    const removed = room.lines.map((line, index) => ({ line, index })).filter(entry => doomed.has(entry.line.id));
    if (!removed.length) return;
    room.lines.splice(0, room.lines.length, ...room.lines.filter(line => !doomed.has(line.id)));
    const claimsBefore = { ...room.characterClaims };
    dropEmptyRoleClaims(room);
    const droppedClaims = Object.fromEntries(Object.entries(claimsBefore).filter(([character]) => !room.characterClaims[character]));

    // Удаление уходит в «корзину» сессии; дубли стираются с диска, только когда отменить уже нельзя
    if (!Array.isArray(room.deletedLines)) room.deletedLines = [];
    room.deletedLines.push({ at: Date.now(), by: nick, lines: removed, claims: droppedClaims });
    while (room.deletedLines.length > MAX_UNDO_BATCHES) {
      room.deletedLines.shift().lines.forEach(entry => deleteTakeFile(entry.line.audioUrl));
    }
    snapshotActive(room);
    saveRooms();
    emitSession(roomId);
    socket.emit('lines_deleted', { count: removed.length });
    logEvent(roomId, `🗑 ${nick} удалил реплик: ${removed.length}`);
  });

  // Отмена последнего удаления реплик (Ctrl+Z у хоста)
  socket.on('host_undo_delete', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, clientId) || !Array.isArray(room.deletedLines) || !room.deletedLines.length) return;
    const batch = room.deletedLines.pop();
    const existing = new Set(room.lines.map(line => line.id));
    const restored = batch.lines.filter(entry => !existing.has(entry.line.id)).sort((a, b) => a.index - b.index);
    restored.forEach(entry => room.lines.splice(Math.min(entry.index, room.lines.length), 0, entry.line));
    // Роли, снятые вместе с последними репликами персонажа, возвращаем, если их никто не занял
    for (const [character, owner] of Object.entries(batch.claims || {})) {
      if (!room.characterClaims[character]) room.characterClaims[character] = owner;
    }
    snapshotActive(room);
    saveRooms();
    emitSession(roomId);
    socket.emit('lines_restored', { count: restored.length });
    logEvent(roomId, `↶ ${nick} вернул удаленные реплики: ${restored.length}`);
  });

  // Хост освобождает выбранные реплики, которые кто-то занял по ошибке
  socket.on('host_release_lines', ({ lineIds } = {}) => {
    if (!roomId || !Array.isArray(lineIds)) return;
    const room = getRoom(roomId);
    if (!isHost(room, clientId)) return;
    let released = 0;
    for (const id of lineIds) {
      const line = room.lines.find(l => l.id === id);
      if (line && line.claimedBy && !room.characterClaims[line.character]) {
        line.claimedBy = null;
        released++;
      }
    }
    if (!released) return;
    saveRooms();
    emitSession(roomId);
    logEvent(roomId, `👑 ${nick} освободил реплик: ${released}`);
  });

  // ---------- Задержка микрофона игрока ----------
  // Одна поправка на все дубли игрока (например, для Bluetooth-наушников)
  socket.on('set_latency', ({ ms } = {}) => {
    if (!roomId || !nick) return;
    const value = Math.round(Number(ms));
    if (!Number.isFinite(value)) return;
    const room = getRoom(roomId);
    const clamped = Math.max(-MAX_LATENCY_MS, Math.min(MAX_LATENCY_MS, value));
    if (clamped === 0) delete room.latency[nick];
    else room.latency[nick] = clamped;
    saveRooms();
    io.to(roomId).emit('latency_updated', room.latency);
    logEvent(roomId, `⏱ ${nick}: поправка задержки ${clamped > 0 ? '+' : ''}${clamped} мс`);
  });

  // ---------- P2P-раздача видео между игроками ----------
  // Сервер только сводит игроков: сами куски видео идут напрямую браузер-браузер (WebRTC)
  socket.on('p2p_have', ({ urls } = {}) => {
    if (!roomId || !Array.isArray(urls)) return;
    const room = getRoom(roomId);
    const allowed = new Set([room.videoUrl, room.backingUrl].filter(Boolean));
    const byUrl = p2pSeeders[roomId] || (p2pSeeders[roomId] = {});
    clearSocketSeeds(roomId, socket.id);
    urls.filter(url => allowed.has(url)).forEach(url => {
      (byUrl[url] || (byUrl[url] = new Set())).add(socket.id);
    });
    broadcastSeeders(roomId);
  });

  socket.on('p2p_find', ({ url } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!roomId) return ack([]);
    const ids = [...((p2pSeeders[roomId] || {})[url] || [])].filter(id => id !== socket.id);
    ack(ids);
  });

  socket.on('p2p_signal', ({ to, data } = {}) => {
    if (!roomId || typeof to !== 'string' || !roomSockets[roomId] || !roomSockets[roomId][to]) return;
    io.to(to).emit('p2p_signal', { from: socket.id, data });
  });

  socket.on('p2p_report', ({ url, p2pBytes, httpBytes, peers } = {}) => {
    if (!roomId) return;
    const mb = bytes => (Math.max(0, Number(bytes) || 0) / 1048576).toFixed(1);
    const name = decodeURIComponent(String(url || '').split('/').pop() || 'файл');
    logEvent(roomId, `⚡ ${nick || 'игрок'} получил ${name}: ${mb(p2pBytes)} МБ от игроков (${Number(peers) || 0}), ${mb(httpBytes)} МБ с сервера`);
  });

  // ---------- Статус записи ----------
  socket.on('recording_status', ({ lineId, recording } = {}) => {
    if (!roomId || !nick) return;
    const room = getRoom(roomId);
    const line = room.lines.find(l => l.id === lineId);
    if (!line) return;
    const map = recordingNow[roomId] || (recordingNow[roomId] = {});

    if (recording) {
      if (getLineOwner(room, line) !== nick) return;
      map[lineId] = { nick, socketId: socket.id };
      logEvent(roomId, `🔴 ${nick} записывает реплику #${lineId}`);
    } else if (map[lineId] && map[lineId].socketId === socket.id) {
      delete map[lineId];
    } else {
      return;
    }
    broadcastRecording(roomId);
  });

  // ---------- Совместный просмотр ----------
  // Синхронизация часов: клиент узнает, насколько его время отличается от серверного
  socket.on('time_sync', (clientTs, ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('host_watch_start', ({ position } = {}) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, clientId) || !room.loaded) return;

    const start = Math.max(0, Number(position) || 0);
    const state = { active: true, playing: true, position: start, at: Date.now() + WATCH_COUNTDOWN_MS };
    watchState[roomId] = state;
    io.to(roomId).emit('watch_start', { ...state, by: nick });
    addSystemMessage(roomId, 'system.watchStart', { nick }, `🎬 ${nick} запустил совместный просмотр`);
    logEvent(roomId, `🎬 ${nick} запустил совместный просмотр`);
  });

  socket.on('host_watch_sync', ({ playing, position } = {}) => {
    if (!roomId || !watchState[roomId]) return;
    if (!isHost(getRoom(roomId), clientId)) return;
    Object.assign(watchState[roomId], { playing: !!playing, position: Math.max(0, Number(position) || 0), at: Date.now() });
    socket.to(roomId).volatile.emit('watch_sync', watchState[roomId]);
  });

  socket.on('host_watch_stop', () => {
    if (!roomId || !isHost(getRoom(roomId), clientId)) return;
    if (endWatch(roomId, nick, `⏹ ${nick} остановил совместный просмотр`)) {
      addSystemMessage(roomId, 'system.watchStop', { nick }, `⏹ ${nick} остановил совместный просмотр`);
    } else {
      // На сервере просмотра уже нет, а у кого-то он «завис» — сбрасываем у всех
      io.to(roomId).emit('watch_stop', { by: nick });
    }
  });

  socket.on('disconnect', leaveCurrentRoom);
});

// start.bat просит открыть браузер, когда сервер реально готов (а не до старта, как раньше)
function openBrowser() {
  if (process.env.DUBLINE_OPEN_BROWSER !== '1') return;
  const url = `http://localhost:${PORT}`;
  const { exec } = require('child_process');
  const command = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {});
}

if (require.main === module) {
  // Ошибка в одном обработчике не должна ронять игру у всех: пишем в журнал и работаем дальше
  process.on('uncaughtException', err => logEvent(null, `💥 Необработанная ошибка (сервер продолжает работу): ${err.stack || err}`, 'error'));
  process.on('unhandledRejection', err => logEvent(null, `💥 Необработанный промис (сервер продолжает работу): ${err && err.stack || err}`, 'error'));
  io.engine.on('connection_error', err => logEvent(null, `⚠ Не удалось подключить игрока: ${err.message}`, 'warn'));

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Dubline] Порт ${PORT} уже занят — похоже, сервер уже запущен в другом окне.`);
      console.error('[Dubline] Открываю страницу уже работающего сервера. Чтобы перезапустить сервер, закройте его окно и запустите start.bat снова.');
      openBrowser();
    } else {
      console.error('[Dubline] Сервер не смог запуститься:', err);
    }
    // Небольшая пауза, чтобы команда открытия браузера успела запуститься
    setTimeout(() => process.exit(1), 500);
  });

  server.listen(PORT, () => {
    console.log(`[Dubline] Сервер запущен: http://localhost:${PORT}`);
    console.log('[Dubline] Здесь будет журнал: кто зашел, кто вышел, ошибки и обрывы связи.');
    openBrowser();
  });
}

module.exports = {
  app,
  server,
  parseAssTime,
  parseSubtitles,
  findEmbeddedSubtitleMap,
  sanitizeRoomId,
  sanitizeNick
};
