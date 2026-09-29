const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, PACKS_DIR, MAX_PACK_MB, MAX_TAKE_MB, MAX_SUBTITLE_MB, HttpError } = require('./config');
const { recordingNow, p2pSeeders } = require('./state');
const { app, io } = require('./app');
const { sanitizeRoomId, sanitizeNick, sanitizePackName } = require('./sanitize');
const { logEvent } = require('./log');
const { forgetFileSizes, deleteTakeFile } = require('./files');
const { runFfmpeg, findEmbeddedSubtitleMap } = require('./media');
const { emptyTake, parseSeconds, readPack, isMkvFile, isMp4File, isSubtitleFile, parseSubtitles } = require('./parsers');
const { saveRooms, getRoom, snapshotActive, startNewSession, publicRoom, emitSession, ensureAudioTracks } = require('./rooms');
const { endWatch, broadcastRecording, addSystemMessage } = require('./presence');
const { isAuthorized, isHost, getLineOwner } = require('./auth');

// ==========================================
// HTTP API
// ==========================================

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

function sendError(res, err) {
  if (err instanceof HttpError) {
    logEvent(null, `⚠ Отклонен запрос (${err.status}): ${err.message}`, 'warn');
    return res.status(err.status).send(err.message);
  }
  logEvent(null, `💥 Ошибка при обработке запроса: ${err.stack || err}`, 'error');
  res.status(500).send('Внутренняя ошибка сервера');
}

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
