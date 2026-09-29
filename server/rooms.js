const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, ROOMS_FILE } = require('./config');
const { rooms } = require('./state');
const { io } = require('./app');
const { logEvent } = require('./log');
const { sceneDirOf, diskPathForUrl, fileSizeForUrl, fileHashForUrl, deleteTakeFile } = require('./files');
const { extractAudioTracks, probeAudioDuration, getWavDuration } = require('./media');
const { isAssDrawing, cleanAssText } = require('./parsers');

// ==========================================
// КОМНАТЫ (с сохранением на диск)
// ==========================================
// Поля сцены, которые принадлежат сессии (см. раздел «Сессии» ниже)
const SESSION_FIELDS = ['loaded', 'title', 'kind', 'zipUrl', 'videoUrl', 'backingUrl', 'lines', 'characterClaims', 'createdAt', 'updatedAt',
  'audioTracks', 'originalTrack', 'backingTrack', 'baseBackingUrl', 'deletedLines'];
let repairedOnLoad = false;

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

// Используется ли папка сцены еще какой-нибудь сессией в любой комнате
function isSceneDirUsed(dir) {
  return Object.values(rooms).some(room => [room, ...Object.values(room.sessions || {})]
    .some(session => sceneDirOf(session.videoUrl) === dir || sceneDirOf(session.backingUrl) === dir));
}

// Реплики в сессии всегда идут по возрастанию номера (так их создает импорт, и список не пересортировывается),
// поэтому возвращенную реплику ставим перед первой с большим номером — порядок восстанавливается точно,
// в каком бы порядке и из каких удалений ни возвращали
function insertLineInOrder(lines, line) {
  const position = lines.findIndex(other => other.id > line.id);
  if (position === -1) lines.push(line);
  else lines.splice(position, 0, line);
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

// Секреты (clientId игроков) никогда не уходят клиентам
function publicRoom(room) {
  const { hostClientId, nickOwners, chat, sessions, passwordHash, passwordSalt, admitted, banned, deletedLines, ...rest } = room;
  return {
    ...rest,
    undoCount: (deletedLines || []).length,
    trashCount: (deletedLines || []).reduce((sum, batch) => sum + batch.lines.length, 0),
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

// Роль без единой реплики больше не нужна
function dropEmptyRoleClaims(room) {
  for (const character of Object.keys(room.characterClaims)) {
    if (!room.lines.some(l => l.character === character)) delete room.characterClaims[character];
  }
}

// Загружаем сохраненные комнаты; починку таймингов сразу сохраняем, чтобы она выполнялась один раз
Object.assign(rooms, loadRooms());
if (repairedOnLoad) writeRoomsNow();

module.exports = {
  saveRooms,
  getRoom,
  emptySession,
  snapshotActive,
  activateSession,
  startNewSession,
  insertLineInOrder,
  deleteSessionFiles,
  publicRoom,
  emitSession,
  ensureAudioTracks,
  dropEmptyRoleClaims
};
