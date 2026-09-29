const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const PACKS_DIR = path.join(PUBLIC_DIR, 'packs');
const DATA_DIR = path.join(__dirname, 'data');
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
const MAX_TAKE_SHIFT = 30;    // насколько далеко (в секундах) дубль можно утащить от реплики

for (const dir of [UPLOAD_DIR, PACKS_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Медиа паков и дубли не меняются по одному адресу — пусть браузер кэширует их,
// а не перекачивает через туннель при каждой перерисовке
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));
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
const rooms = loadRooms();
const roomSockets = {}; // { roomId: { socketId: { nick, clientId } } }

function loadRooms() {
  try {
    if (fs.existsSync(ROOMS_FILE)) return JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')) || {};
  } catch (err) {
    console.error('[Dubline] Не удалось прочитать сохраненные комнаты:', err.message);
  }
  return {};
}

function writeRoomsNow() {
  try {
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
    chat: []
  };
  for (const key in defaults) {
    if (rooms[roomId][key] === undefined) rooms[roomId][key] = defaults[key];
  }
  return rooms[roomId];
}

// Размеры медиафайлов показываем на кнопках скачивания. Кэшируем, чтобы не дергать диск
// на каждую рассылку сессии; неизвестные размеры (файл еще пишется) не кэшируем.
const fileSizeCache = new Map();

function fileSizeForUrl(url) {
  if (!url) return null;
  if (fileSizeCache.has(url)) return fileSizeCache.get(url);
  try {
    const full = path.join(PUBLIC_DIR, decodeURIComponent(url).replace(/^\/+/, ''));
    if (!full.startsWith(PUBLIC_DIR + path.sep)) return null;
    const size = fs.statSync(full).size;
    fileSizeCache.set(url, size);
    return size;
  } catch (err) {
    return null;
  }
}

function forgetFileSizes(...urls) {
  urls.forEach(url => { if (url) fileSizeCache.delete(url); });
}

// Секреты (clientId игроков) никогда не уходят клиентам
function publicRoom(room) {
  const { hostClientId, nickOwners, chat, ...rest } = room;
  return {
    ...rest,
    videoSize: fileSizeForUrl(room.videoUrl),
    backingSize: fileSizeForUrl(room.backingUrl),
    zipSize: fileSizeForUrl(room.zipUrl)
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
const watchState = {};   // roomId -> { active, playing, position, at }
const WATCH_COUNTDOWN_MS = 3000;

function recordingList(roomId) {
  return Object.entries(recordingNow[roomId] || {}).map(([lineId, rec]) => ({ lineId: Number(lineId), nick: rec.nick }));
}

function broadcastRecording(roomId) {
  io.to(roomId).emit('recording_state', recordingList(roomId));
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
    recordedBy: null      // кто записал дубль (чтобы его можно было послушать, даже когда реплика освобождена)
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

  // Дубли от прошлого пака больше не нужны — чистим диск
  room.lines.forEach(line => deleteTakeFile(line.audioUrl));

  room.loaded = true;
  room.title = pack.title;
  room.zipUrl = `/packs/${encodeURIComponent(packName)}`;
  room.videoUrl = pack.videoUrl;
  room.backingUrl = pack.backingUrl;
  room.lines = pack.lines;
  room.characterClaims = {};
  forgetFileSizes(room.zipUrl, room.videoUrl, room.backingUrl);
  delete recordingNow[roomId];
  delete watchState[roomId];

  saveRooms();
  emitSession(roomId);
  broadcastRecording(roomId);
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
  const streams = [...output.matchAll(/Stream #0:(\d+)(?:\([^)]*\))?: Subtitle: ([^,\s]+)/gi)];
  const supported = streams.find(match => /^(ass|ssa|subrip|srt|webvtt)$/i.test(match[2]));
  return supported ? `0:${supported[1]}` : null;
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

        caption = caption.replace(/\{[^}]+\}/g, '').replace(/\\N/gi, ' ').replace(/\\n/gi, ' ').trim();
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

    room.lines.forEach(line => deleteTakeFile(line.audioUrl));

    room.loaded = true;
    room.title = customTitle;
    room.zipUrl = '';
    room.videoUrl = `/uploads/${encodeURIComponent(dirName)}/${encodeURIComponent(videoName)}`;
    room.backingUrl = '';
    room.lines = lines;
    room.characterClaims = {};
    forgetFileSizes(room.videoUrl);
    delete recordingNow[roomId];
    delete watchState[roomId];

    saveRooms();
    emitSession(roomId);
    broadcastRecording(roomId);
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

    if (!req.file || !lineId) throw new HttpError(400, 'Некорректные данные');
    if (!isAuthorized(room, userName, req.body.clientId)) throw new HttpError(403, 'Ник не подтвержден — перезайдите в комнату');

    const line = room.lines.find(l => l.id === lineId);
    if (!line) throw new HttpError(404, 'Реплика не найдена');

    const owner = getLineOwner(room, line);
    if (owner !== userName) throw new HttpError(403, 'Реплика занята другим игроком');

    const fileName = `line_${roomId}_${lineId}_${Date.now()}.webm`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fileName), req.file.buffer);

    deleteTakeFile(line.audioUrl);
    line.audioUrl = `/uploads/${encodeURIComponent(fileName)}`;
    line.audioStart = audioStart !== null ? Math.max(0, audioStart) : line.start;
    line.recordedStart = line.audioStart;
    line.recordedBy = userName;
    // Выбранный голос (эффект/питч) переживает перезапись дубля
    const hasTrim = trimStart !== null && trimEnd !== null && trimStart >= 0 && trimEnd > trimStart;
    line.trimStart = hasTrim ? trimStart : null;
    line.trimEnd = hasTrim ? trimEnd : null;
    if (line.trimEnabled === undefined) line.trimEnabled = true;
    if (!line.effect) line.effect = 'none';
    if (!line.pitch) line.pitch = 0;

    saveRooms();
    io.to(roomId).emit('line_updated', line);
    logEvent(roomId, `💾 ${userName} сохранил дубль реплики #${lineId} (${Math.round(req.file.size / 1024)} КБ)`);
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

  function leaveCurrentRoom(reason) {
    if (roomId && roomSockets[roomId] && roomSockets[roomId][socket.id]) {
      const room = getRoom(roomId);
      const wasHost = isHost(room, clientId);
      delete roomSockets[roomId][socket.id];
      socket.leave(roomId);
      if (clearSocketRecordings(roomId, socket.id)) broadcastRecording(roomId);
      broadcastRoomUsers(roomId);

      const why = typeof reason === 'string' ? ` — ${DISCONNECT_REASONS[reason] || reason}` : '';
      logEvent(roomId, `← ${nick || 'игрок без ника'} вышел${why}. Онлайн: ${onlineCount(roomId)}`, reason === 'ping timeout' || reason === 'transport error' ? 'warn' : 'info');

      // Хост ушел совсем — совместный просмотр заканчивается
      if (wasHost && !isHostOnline(roomId) && watchState[roomId]) {
        delete watchState[roomId];
        io.to(roomId).emit('watch_stop', { by: nick });
        logEvent(roomId, '🎬 Совместный просмотр остановлен: хост вышел');
      }
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
  }

  socket.on('join_room', (data = {}) => {
    const nextClientId = String(data.clientId || '').slice(0, 64);
    if (!nextClientId) return;

    const nextRoomId = sanitizeRoomId(data.room);
    if (roomId && roomId !== nextRoomId) leaveCurrentRoom();

    roomId = nextRoomId;
    clientId = nextClientId;
    const room = getRoom(roomId);

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
    socket.emit('session_updated', publicRoom(room));
    socket.emit('chat_history', room.chat);
    socket.emit('recording_state', recordingList(roomId));
    if (watchState[roomId]) socket.emit('watch_sync', watchState[roomId]);
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
    if (!roomId || !watchState[roomId]) return;
    if (!isHost(getRoom(roomId), clientId)) return;
    delete watchState[roomId];
    io.to(roomId).emit('watch_stop', { by: nick });
    addSystemMessage(roomId, 'system.watchStop', { nick }, `⏹ ${nick} остановил совместный просмотр`);
    logEvent(roomId, `⏹ ${nick} остановил совместный просмотр`);
  });

  socket.on('disconnect', leaveCurrentRoom);
});

if (require.main === module) {
  // Ошибка в одном обработчике не должна ронять игру у всех: пишем в журнал и работаем дальше
  process.on('uncaughtException', err => logEvent(null, `💥 Необработанная ошибка (сервер продолжает работу): ${err.stack || err}`, 'error'));
  process.on('unhandledRejection', err => logEvent(null, `💥 Необработанный промис (сервер продолжает работу): ${err && err.stack || err}`, 'error'));
  io.engine.on('connection_error', err => logEvent(null, `⚠ Не удалось подключить игрока: ${err.message}`, 'warn'));

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Dubline] Порт ${PORT} уже занят — похоже, сервер уже запущен в другом окне. Закройте его и запустите снова.`);
    } else {
      console.error('[Dubline] Сервер не смог запуститься:', err);
    }
    process.exit(1);
  });

  server.listen(PORT, () => {
    console.log(`[Dubline] Сервер запущен: http://localhost:${PORT}`);
    console.log('[Dubline] Здесь будет журнал: кто зашел, кто вышел, ошибки и обрывы связи.');
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
