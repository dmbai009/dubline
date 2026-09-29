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

const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const PACKS_DIR = path.join(__dirname, 'public', 'packs');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(PACKS_DIR)) fs.mkdirSync(PACKS_DIR, { recursive: true });

app.use(express.static('public'));
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage });

// Хранилище комнат и пользователей
const rooms = {};
const roomSockets = {}; // { roomId: { socketId: userName } }

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      loaded: false,
      title: '',
      zipUrl: '',
      videoUrl: '',
      backingUrl: '',
      lines: [],
      characterClaims: {}
    };
  }
  return rooms[roomId];
}

function broadcastRoomUsers(roomId) {
  const usersMap = roomSockets[roomId] || {};
  const uniqueUsers = [...new Set(Object.values(usersMap))];
  io.to(roomId).emit('room_users_updated', uniqueUsers);
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
    audioUrl: null,
    audioStart: null
  };
}

// Загрузка ZIP-мода (с сохранением в библиотеку модов)
app.post('/api/upload-pack', upload.single('pack'), (req, res) => {
  try {
    const roomId = req.query.room || 'main';
    const room = getRoom(roomId);

    if (!req.file) return res.status(400).send('Файл не передан');

    const cleanPackName = req.file.originalname.replace(/[^a-zA-Z0-9_\-\u0400-\u04FF.]/g, '_');
    const savedZipPath = path.join(PACKS_DIR, cleanPackName);
    fs.writeFileSync(savedZipPath, req.file.buffer);

    console.log(`\n[Dubline] Загружен мод [${cleanPackName}] в комнату [${roomId}]`);

    const zip = new AdmZip(req.file.buffer);
    const zipEntries = zip.getEntries();
    const sessionDirName = `session_${roomId}_${Date.now()}`;
    const targetDir = path.join(UPLOAD_DIR, sessionDirName);
    fs.mkdirSync(targetDir, { recursive: true });

    let videoFile = null;
    let backingFile = null;
    const rawLineFiles = [];
    const audioFilesMap = {};
    const audioByNumber = {};
    const audioDurations = {};

    zipEntries.forEach(entry => {
      const name = entry.entryName.split('/').pop();
      if (!name) return;

      const lower = name.toLowerCase();
      const ext = path.extname(lower);
      const stem = path.basename(lower, ext);
      const outPath = path.join(targetDir, name);
      fs.writeFileSync(outPath, entry.getData());

      if (lower === 'dub_video.mp4') videoFile = name;
      if (lower.includes('backing_track')) backingFile = name;

      if (['.wav', '.mp3', '.ogg'].includes(ext) && !lower.startsWith('_')) {
        audioFilesMap[stem] = name;
        const num = (name.match(/\d+/) || [null])[0];
        if (num !== null) audioByNumber[parseInt(num, 10)] = name;

        if (ext === '.wav') {
          const dur = getWavDuration(entry.getData());
          if (dur) audioDurations[name] = dur;
        }
      }

      if ((lower.endsWith('.ini') || lower.endsWith('.txt')) && !lower.startsWith('_') && !lower.includes('readme')) {
        const textContent = entry.getData().toString('utf8');
        if (/caption|dub_timestamps|dub_characters/i.test(textContent)) {
          rawLineFiles.push({ name, stem, content: textContent });
        }
      }
    });

    rawLineFiles.sort((a, b) => {
      const numA = (a.name.match(/\d+/) || [0])[0];
      const numB = (b.name.match(/\d+/) || [0])[0];
      return parseInt(numA, 10) - parseInt(numB, 10);
    });

    const lines = rawLineFiles.map((item, idx) => {
      const num = (item.name.match(/\d+/) || [idx + 1])[0];
      const lineId = parseInt(num, 10);
      const matchedAudio = audioFilesMap[item.stem] || audioByNumber[lineId];
      const origUrl = matchedAudio ? `/uploads/${sessionDirName}/${matchedAudio}` : null;
      const dur = matchedAudio ? audioDurations[matchedAudio] : null;

      return parseLineContent(item.content, item.name, lineId, origUrl, dur);
    });

    room.loaded = true;
    room.title = cleanPackName.replace(/\.zip$/i, '');
    room.zipUrl = `/packs/${cleanPackName}`;
    room.videoUrl = videoFile ? `/uploads/${sessionDirName}/${videoFile}` : '';
    room.backingUrl = backingFile ? `/uploads/${sessionDirName}/${backingFile}` : '';
    room.lines = lines;
    room.characterClaims = {};

    io.to(roomId).emit('session_updated', room);
    res.json({ success: true, session: room });
  } catch (err) {
    console.error('[Dubline] Ошибка:', err);
    res.status(500).send('Ошибка при распаковке: ' + err.message);
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
        url: `/packs/${file}`
      };
    });
    res.json(list);
  } catch (err) {
    res.status(500).json([]);
  }
});

// Загрузить в комнату мод, уже сохраненный на сервере
app.post('/api/load-server-pack', (req, res) => {
  try {
    const { filename, room: roomId } = req.body;
    const targetRoomId = roomId || 'main';
    const filePath = path.join(PACKS_DIR, filename);

    if (!fs.existsSync(filePath)) return res.status(404).send('Мод не найден на сервере');

    const buffer = fs.readFileSync(filePath);
    const room = getRoom(targetRoomId);

    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();
    const sessionDirName = `session_${targetRoomId}_${Date.now()}`;
    const targetDir = path.join(UPLOAD_DIR, sessionDirName);
    fs.mkdirSync(targetDir, { recursive: true });

    let videoFile = null;
    let backingFile = null;
    const rawLineFiles = [];
    const audioFilesMap = {};
    const audioByNumber = {};
    const audioDurations = {};

    zipEntries.forEach(entry => {
      const name = entry.entryName.split('/').pop();
      if (!name) return;
      const lower = name.toLowerCase();
      const ext = path.extname(lower);
      const stem = path.basename(lower, ext);
      const outPath = path.join(targetDir, name);
      fs.writeFileSync(outPath, entry.getData());

      if (lower === 'dub_video.mp4') videoFile = name;
      if (lower.includes('backing_track')) backingFile = name;

      if (['.wav', '.mp3', '.ogg'].includes(ext) && !lower.startsWith('_')) {
        audioFilesMap[stem] = name;
        const num = (name.match(/\d+/) || [null])[0];
        if (num !== null) audioByNumber[parseInt(num, 10)] = name;
        if (ext === '.wav') {
          const dur = getWavDuration(entry.getData());
          if (dur) audioDurations[name] = dur;
        }
      }

      if ((lower.endsWith('.ini') || lower.endsWith('.txt')) && !lower.startsWith('_') && !lower.includes('readme')) {
        const textContent = entry.getData().toString('utf8');
        if (/caption|dub_timestamps|dub_characters/i.test(textContent)) {
          rawLineFiles.push({ name, stem, content: textContent });
        }
      }
    });

    rawLineFiles.sort((a, b) => {
      const numA = (a.name.match(/\d+/) || [0])[0];
      const numB = (b.name.match(/\d+/) || [0])[0];
      return parseInt(numA, 10) - parseInt(numB, 10);
    });

    const lines = rawLineFiles.map((item, idx) => {
      const num = (item.name.match(/\d+/) || [idx + 1])[0];
      const lineId = parseInt(num, 10);
      const matchedAudio = audioFilesMap[item.stem] || audioByNumber[lineId];
      const origUrl = matchedAudio ? `/uploads/${sessionDirName}/${matchedAudio}` : null;
      const dur = matchedAudio ? audioDurations[matchedAudio] : null;

      return parseLineContent(item.content, item.name, lineId, origUrl, dur);
    });

    room.loaded = true;
    room.title = filename.replace(/\.zip$/i, '');
    room.zipUrl = `/packs/${filename}`;
    room.videoUrl = videoFile ? `/uploads/${sessionDirName}/${videoFile}` : '';
    room.backingUrl = backingFile ? `/uploads/${sessionDirName}/${backingFile}` : '';
    room.lines = lines;
    room.characterClaims = {};

    io.to(targetRoomId).emit('session_updated', room);
    res.json({ success: true, session: room });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка при загрузке: ' + err.message);
  }
});

// Загрузка дубля
app.post('/api/upload-line-audio', upload.single('audio'), (req, res) => {
  const roomId = req.query.room || 'main';
  const room = getRoom(roomId);

  const lineId = parseInt(req.body.lineId);
  const userName = req.body.userName;
  const audioStart = req.body.audioStart !== undefined ? parseFloat(req.body.audioStart) : null;

  if (!req.file || !lineId) return res.status(400).send('Некорректные данные');

  const line = room.lines.find(l => l.id === lineId);
  if (!line) return res.status(404).send('Реплика не найдена');

  const charOwner = room.characterClaims[line.character];
  const effectiveOwner = charOwner || line.claimedBy;

  if (effectiveOwner && effectiveOwner !== userName) {
    return res.status(403).send('Реплика занята другим игроком');
  }

  const fileName = `line_${roomId}_${lineId}_${Date.now()}.webm`;
  const filePath = path.join(UPLOAD_DIR, fileName);
  fs.writeFileSync(filePath, req.file.buffer);

  const audioUrl = `/uploads/${fileName}`;
  line.audioUrl = audioUrl;
  line.audioStart = audioStart !== null && !isNaN(audioStart) ? audioStart : line.start;

  io.to(roomId).emit('line_updated', line);
  res.json({ success: true, audioUrl, audioStart: line.audioStart });
});

// Удаление дубля (стереть неудачную запись)
app.post('/api/delete-line-audio', (req, res) => {
  const { lineId, userName, room: roomId } = req.body;
  const room = getRoom(roomId || 'main');

  const line = room.lines.find(l => l.id === parseInt(lineId));
  if (!line) return res.status(404).send('Реплика не найдена');

  const charOwner = room.characterClaims[line.character];
  const effectiveOwner = charOwner || line.claimedBy;

  if (effectiveOwner && effectiveOwner !== userName) {
    return res.status(403).send('Нельзя удалить чужой дубль');
  }

  line.audioUrl = null;
  line.audioStart = null;

  io.to(roomId || 'main').emit('line_updated', line);
  res.json({ success: true });
});

io.on('connection', socket => {
  let userRoom = 'main';
  let userNick = '';

  socket.on('join_room', ({ room: roomId, nick }) => {
    userRoom = roomId || 'main';
    userNick = nick || 'Аноним';

    socket.join(userRoom);
    if (!roomSockets[userRoom]) roomSockets[userRoom] = {};
    roomSockets[userRoom][socket.id] = userNick;

    const room = getRoom(userRoom);
    socket.emit('session_updated', room);
    broadcastRoomUsers(userRoom);
  });

  socket.on('rename_user', ({ oldName, newName }) => {
    if (!oldName || !newName || oldName === newName) return;
    const room = getRoom(userRoom);

    userNick = newName;
    if (roomSockets[userRoom]) roomSockets[userRoom][socket.id] = newName;

    let changed = false;
    if (room.characterClaims) {
      for (const char in room.characterClaims) {
        if (room.characterClaims[char] === oldName) {
          room.characterClaims[char] = newName;
          changed = true;
        }
      }
    }

    if (room.lines) {
      room.lines.forEach(l => {
        if (l.claimedBy === oldName) {
          l.claimedBy = newName;
          changed = true;
        }
      });
    }

    broadcastRoomUsers(userRoom);
    if (changed) io.to(userRoom).emit('session_updated', room);
  });

  socket.on('claim_character', ({ character, userName }) => {
    const room = getRoom(userRoom);
    if (!room.characterClaims) room.characterClaims = {};
    if (!room.characterClaims[character]) {
      room.characterClaims[character] = userName;
      room.lines.forEach(l => {
        if (l.character === character) l.claimedBy = userName;
      });
      io.to(userRoom).emit('session_updated', room);
    }
  });

  socket.on('unclaim_character', ({ character, userName }) => {
    const room = getRoom(userRoom);
    if (room.characterClaims && room.characterClaims[character] === userName) {
      delete room.characterClaims[character];
      room.lines.forEach(l => {
        if (l.character === character && l.claimedBy === userName) {
          l.claimedBy = null;
        }
      });
      io.to(userRoom).emit('session_updated', room);
    }
  });

  socket.on('claim_line', ({ lineId, userName }) => {
    const room = getRoom(userRoom);
    const line = room.lines.find(l => l.id === lineId);
    if (line) {
      const charOwner = room.characterClaims[line.character];
      if (charOwner && charOwner !== userName) return;
      if (!line.claimedBy || line.claimedBy === userName) {
        line.claimedBy = userName;
        io.to(userRoom).emit('line_updated', line);
      }
    }
  });

  socket.on('unclaim_line', ({ lineId, userName }) => {
    const room = getRoom(userRoom);
    const line = room.lines.find(l => l.id === lineId);
    if (line) {
      const charOwner = room.characterClaims[line.character];
      if (charOwner && charOwner === userName) return;
      if (line.claimedBy === userName) {
        line.claimedBy = null;
        io.to(userRoom).emit('line_updated', line);
      }
    }
  });

  socket.on('disconnect', () => {
    if (roomSockets[userRoom] && roomSockets[userRoom][socket.id]) {
      delete roomSockets[userRoom][socket.id];
      broadcastRoomUsers(userRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Dubline] Сервер запущен: http://localhost:${PORT}`);
});