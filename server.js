const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

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
const MAX_NICK_LENGTH = 16;
const MAX_CHAT_LENGTH = 500;
const MAX_CHAT_HISTORY = 100;
const CHAT_RATE_LIMIT = { count: 5, windowMs: 5000 };

for (const dir of [UPLOAD_DIR, PACKS_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(express.static(PUBLIC_DIR));
app.use(express.json());

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

// Секреты (clientId игроков) никогда не уходят клиентам
function publicRoom(room) {
  const { hostClientId, nickOwners, chat, ...rest } = room;
  return rest;
}

function emitSession(roomId) {
  io.to(roomId).emit('session_updated', publicRoom(getRoom(roomId)));
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

function addSystemMessage(roomId, text) {
  addChatMessage(roomId, { system: true, text });
}

// Ник закреплен за устройством (clientId), чтобы никто не мог выдать себя за другого игрока
function isNickFree(room, nick, clientId) {
  const owner = room.nickOwners[nick];
  return !owner || owner === clientId;
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
    audioUrl: null,
    audioStart: null
  };
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

  saveRooms();
  emitSession(roomId);
  addSystemMessage(roomId, `🎬 Хост запустил пак «${pack.title}»`);
  return room;
}

function acceptFile(field, maxMb) {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 }
  }).single(field);

  return (req, res, next) => handler(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).send(`Файл слишком большой (максимум ${maxMb} МБ)`);
    res.status(400).send('Ошибка загрузки: ' + err.message);
  });
}

function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).send(err.message);
  console.error('[Dubline] Ошибка:', err);
  res.status(500).send('Внутренняя ошибка сервера: ' + err.message);
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

// Загрузка дубля
app.post('/api/upload-line-audio', acceptFile('audio', MAX_TAKE_MB), (req, res) => {
  try {
    const roomId = sanitizeRoomId(req.query.room);
    const room = getRoom(roomId);

    const lineId = parseInt(req.body.lineId, 10);
    const userName = sanitizeNick(req.body.userName);
    const audioStart = req.body.audioStart !== undefined ? parseFloat(req.body.audioStart) : null;

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
    line.audioStart = audioStart !== null && !isNaN(audioStart) ? audioStart : line.start;

    saveRooms();
    io.to(roomId).emit('line_updated', line);
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
    line.audioUrl = null;
    line.audioStart = null;

    saveRooms();
    io.to(roomId).emit('line_updated', line);
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

  function leaveCurrentRoom() {
    if (roomId && roomSockets[roomId]) {
      delete roomSockets[roomId][socket.id];
      socket.leave(roomId);
      broadcastRoomUsers(roomId);
    }
  }

  function renameClaims(room, oldName, newName) {
    for (const char in room.characterClaims) {
      if (room.characterClaims[char] === oldName) room.characterClaims[char] = newName;
    }
    room.lines.forEach(l => {
      if (l.claimedBy === oldName) l.claimedBy = newName;
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
    let error = null;
    if (requested && !isNickFree(room, requested, clientId)) {
      error = `Ник «${requested}» уже занят другим игроком в этой комнате`;
      requested = '';
    }
    nick = requested;
    if (nick) room.nickOwners[nick] = clientId;

    // Первый зашедший в комнату становится хостом
    if (!room.hostClientId) room.hostClientId = clientId;
    if (room.hostClientId === clientId && nick) room.host = nick;

    socket.join(roomId);
    if (!roomSockets[roomId]) roomSockets[roomId] = {};
    roomSockets[roomId][socket.id] = { nick, clientId };

    saveRooms();
    socket.emit('nick_state', { nick, error });
    socket.emit('session_updated', publicRoom(room));
    socket.emit('chat_history', room.chat);
    broadcastRoomUsers(roomId);
  });

  socket.on('rename_user', (data = {}) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const newName = sanitizeNick(data.newName);
    if (!newName || newName === nick) return socket.emit('nick_state', { nick });

    if (!isNickFree(room, newName, clientId)) {
      return socket.emit('nick_state', { nick, error: `Ник «${newName}» уже занят другим игроком` });
    }

    const oldName = nick;
    if (oldName && room.nickOwners[oldName] === clientId) delete room.nickOwners[oldName];
    room.nickOwners[newName] = clientId;
    nick = newName;
    roomSockets[roomId][socket.id].nick = newName;

    if (oldName) renameClaims(room, oldName, newName);
    if (room.hostClientId === clientId) room.host = newName;

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
    if (owner !== nick) addSystemMessage(roomId, `👑 Хост снял роль «${character}» с игрока ${owner}`);
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
    if (owner !== nick) addSystemMessage(roomId, `👑 Хост освободил реплику #${line.id} игрока ${owner}`);
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
    addSystemMessage(roomId, '♻️ Хост сбросил все роли и реплики (записанные дубли сохранены)');
  });

  socket.on('host_force_pause', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, clientId)) return;

    io.to(roomId).emit('force_pause', { by: nick });
    addSystemMessage(roomId, `⏸ Хост ${nick} поставил видео на паузу у всех`);
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
    addSystemMessage(roomId, `👑 ${nick} теперь хост комнаты`);
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

  socket.on('disconnect', leaveCurrentRoom);
});

server.listen(PORT, () => {
  console.log(`[Dubline] Сервер запущен: http://localhost:${PORT}`);
});
