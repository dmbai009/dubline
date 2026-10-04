const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { UPLOAD_DIR, PACKS_DIR, MAX_PACK_MB, MAX_PACK_EXPORT_MB, MAX_EXPORT_LINE_SECONDS, MAX_TAKE_MB, MAX_SUBTITLE_MB, HttpError } = require('./config');
const { recordingNow, p2pSeeders, roomSockets } = require('./state');
const { app, io } = require('./app');
const { sanitizeNick, sanitizePackName } = require('./sanitize');
const { resolveRoomId } = require('./desktop');
const { logEvent } = require('./log');
const { forgetFileSizes, deleteTakeFile, diskPathForUrl } = require('./files');
const { runFfmpeg, findEmbeddedSubtitleMap } = require('./media');
const { emptyTake, parseSeconds, readPack, isMkvFile, isMp4File, isSubtitleFile, parseSubtitles } = require('./parsers');
const { saveRooms, getRoom, snapshotActive, startNewSession, publicRoom, emitSession, ensureAudioTracks } = require('./rooms');
const { endWatch, broadcastRecording, addSystemMessage } = require('./presence');
const { isAuthorized, isHost, getLineOwner } = require('./auth');
const { parseWorkshopUrl, downloadVoxalikePack } = require('./workshop');

const workshopDownloads = new Map();
let packExportActive = false;

// ==========================================
// HTTP API
// ==========================================

function loadPackIntoRoom(roomId, packName, buffer, forceExtract) {
  const room = getRoom(roomId);
  const pack = readPack(buffer, packName, forceExtract);

  // A new pack starts a new session: earlier sessions and their takes are kept
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
  endWatch(roomId, null, '🎬 Watch-together stopped: the pack changed');
  delete p2pSeeders[roomId];

  saveRooms();
  emitSession(roomId);
  broadcastRecording(roomId);
  ensureAudioTracks(roomId);
  logEvent(roomId, `🎬 Pack "${pack.title}" started (${pack.lines.length} lines)`);
  addSystemMessage(roomId, 'system.packLoaded', { title: pack.title }, `🎬 The host started the pack "${pack.title}"`);
  return room;
}

function uploadErrorHandler(handler, maxMb) {
  return (req, res, next) => handler(req, res, err => {
    if (!err) return next();
    if (err instanceof HttpError) return sendError(res, err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      logEvent(null, `⚠ Upload rejected: file is larger than ${maxMb} MB`, 'warn');
      return sendJsonError(res, 413, `File is too large (max ${maxMb} MB)`, 'error.fileTooBig', { max: maxMb });
    }
    sendJsonError(res, 400, `Upload failed: ${err.message}`, 'error.uploadFailed', { message: err.message });
  });
}

// Uploads are kept in memory, so rights are checked before a file is read at all: the client sends
// clientId (and the nickname) ahead of the file, and multer calls the filter with those fields parsed.
// Without this, anyone could make the server buffer hundreds of MB just to be refused afterwards.
// The route handlers check the same rights again.
function checkedBefore(authorize) {
  return (req, file, cb) => {
    try {
      authorize(req);
      cb(null, true);
    } catch (err) {
      cb(err);
    }
  };
}

function requireHost(message, key) {
  return req => {
    const room = getRoom(resolveRoomId(req.query.room));
    if (!isHost(room, req.body && req.body.clientId)) throw new HttpError(403, message, key);
  };
}

function requireConfirmedNick(req) {
  const body = req.body || {};
  const room = getRoom(resolveRoomId(req.query.room));
  if (!isAuthorized(room, sanitizeNick(body.userName), body.clientId)) {
    throw new HttpError(403, 'Nickname not confirmed: rejoin the room', 'error.nickNotConfirmed');
  }
}

function acceptFile(field, maxMb, authorize) {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
    fileFilter: checkedBefore(authorize)
  }).single(field);
  return uploadErrorHandler(handler, maxMb);
}

function acceptCustomFiles(maxMb, authorize) {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024 },
    fileFilter: checkedBefore(authorize)
  }).fields([
    { name: 'video', maxCount: 1 },
    { name: 'subtitles', maxCount: 1 }
  ]);
  return uploadErrorHandler(handler, maxMb);
}

// The client shows `key` translated into the player's language and falls back to the English `error`
function sendJsonError(res, status, message, key = null, params = {}) {
  res.status(status).json({ error: message, key, params });
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    logEvent(null, `⚠ Request rejected (${err.status}): ${err.message}`, 'warn');
    return sendJsonError(res, err.status, err.message, err.key, err.params);
  }
  logEvent(null, `💥 Request failed: ${err.stack || err}`, 'error');
  sendJsonError(res, 500, 'Internal server error', 'error.internal');
}

// Upload a ZIP mod (kept in the mod library). Host only.
app.post('/api/upload-pack', acceptFile('pack', MAX_PACK_MB, requireHost('Only the room host can change the pack', 'error.hostOnlyPack')), (req, res) => {
  try {
    const roomId = resolveRoomId(req.query.room);
    const room = getRoom(roomId);

    if (!isHost(room, req.body.clientId)) throw new HttpError(403, 'Only the room host can change the pack', 'error.hostOnlyPack');
    if (!req.file) throw new HttpError(400, 'No file was sent', 'error.noFile');

    const packName = sanitizePackName(req.file.originalname);
    if (!packName) throw new HttpError(400, 'A .zip archive is required', 'error.needZip');

    // Make sure the archive can be read before saving it to the library
    const updatedRoom = loadPackIntoRoom(roomId, packName, req.file.buffer, true);
    fs.writeFileSync(path.join(PACKS_DIR, packName), req.file.buffer);
    // The archive has just been written: send the session again, now with its size
    forgetFileSizes(updatedRoom.zipUrl);
    emitSession(roomId);

    console.log(`[Dubline] Mod [${packName}] uploaded to room [${roomId}]`);
    res.json({ success: true, session: publicRoom(updatedRoom) });
  } catch (err) {
    sendError(res, err);
  }
});

// Mods saved on the server
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

// Download a public Voxalike Workshop pack once and reuse the validated archive afterwards.
app.post('/api/import-workshop-pack', async (req, res) => {
  try {
    const roomId = resolveRoomId(req.body.room);
    const room = getRoom(roomId);
    if (!isHost(room, req.body.clientId)) throw new HttpError(403, 'Only the room host can change the pack', 'error.hostOnlyPack');

    const source = parseWorkshopUrl(req.body.url);
    const filePath = path.join(PACKS_DIR, source.filename);
    let cached = fs.existsSync(filePath);
    let buffer;
    if (cached) {
      buffer = fs.readFileSync(filePath);
    } else {
      let pending = workshopDownloads.get(source.filename);
      if (!pending) {
        pending = downloadVoxalikePack(source.downloadUrl, MAX_PACK_MB * 1024 * 1024)
          .finally(() => workshopDownloads.delete(source.filename));
        workshopDownloads.set(source.filename, pending);
      }
      buffer = await pending;
      // Another request awaiting the same download may have populated the cache first.
      cached = fs.existsSync(filePath);
      if (cached) buffer = fs.readFileSync(filePath);
    }

    // The archive is on disk before the room points at it; readPack then validates it
    // (including the unpacked size) and an invalid download leaves the library again.
    let written = false;
    if (!cached) {
      try {
        fs.writeFileSync(filePath, buffer, { flag: 'wx' });
        written = true;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        cached = true;
      }
    }
    let updatedRoom;
    try {
      updatedRoom = loadPackIntoRoom(roomId, source.filename, buffer, written);
    } catch (err) {
      if (written) fs.rm(filePath, { force: true }, () => {});
      throw err;
    }
    logEvent(roomId, `📦 Voxalike workshop pack "${source.slug}" ${cached ? 'loaded from cache' : 'downloaded'}`);
    res.json({ success: true, cached, session: publicRoom(updatedRoom) });
  } catch (err) {
    sendError(res, err);
  }
});

function packSafeName(value, fallback) {
  const clean = String(value || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 70);
  return clean || fallback;
}

function iniQuoted(value) {
  return JSON.stringify(String(value || ''));
}

// Build a standard Voxalike pack from the edited timeline. Host only because FFmpeg work
// happens on the host machine and can be expensive for a long scene.
app.post('/api/export-voxalike-pack', async (req, res) => {
  let tempDir = null;
  let ownsExportSlot = false;
  try {
    const roomId = resolveRoomId(req.body.room);
    const room = getRoom(roomId);
    if (!isHost(room, req.body.clientId)) throw new HttpError(403, 'Only the room host can export a pack', 'error.hostOnlyPack');
    if (packExportActive) throw new HttpError(409, 'Another pack export is in progress on this host', 'error.packExportBusy');
    if (!room.loaded || !room.videoUrl || !room.lines.length) throw new HttpError(400, 'The scene has no video or lines', 'error.noScene');
    if (room.lines.length > 2000) throw new HttpError(400, 'The scene has too many lines', 'error.tooManyLines');
    const videoPath = diskPathForUrl(room.videoUrl);
    if (!videoPath || !fs.existsSync(videoPath)) throw new HttpError(404, 'Scene video not found', 'error.noScene');

    const backingPath = diskPathForUrl(room.backingUrl);
    // Export one snapshot: collaborative edits during FFmpeg awaits must not
    // mix old audio cuts with new captions, roles or timestamps in the archive.
    const ordered = room.lines.map(line => ({ ...line })).sort((a, b) => a.start - b.start || a.id - b.id);
    let estimatedBytes = fs.statSync(videoPath).size;
    if (backingPath && fs.existsSync(backingPath)) estimatedBytes += fs.statSync(backingPath).size;
    for (const line of ordered) {
      const duration = Number(line.end) - Number(line.start);
      if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_EXPORT_LINE_SECONDS) {
        throw new HttpError(413, `A line is longer than ${MAX_EXPORT_LINE_SECONDS} seconds`, 'error.exportLineTooLong', { max: MAX_EXPORT_LINE_SECONDS });
      }
      // PCM stereo, 44.1 kHz, 16-bit, plus a conservative allowance for metadata.
      estimatedBytes += Math.ceil(duration * 44100 * 2 * 2) + 4096;
    }
    if (estimatedBytes > MAX_PACK_EXPORT_MB * 1024 * 1024) {
      throw new HttpError(413, `The exported pack would exceed ${MAX_PACK_EXPORT_MB} MB`, 'error.packExportTooLarge', { max: MAX_PACK_EXPORT_MB });
    }

    packExportActive = true;
    ownsExportSlot = true;
    const requestId = typeof req.body.requestId === 'string' ? req.body.requestId.slice(0, 80) : '';
    // Notify only the requesting host's windows, with a per-export identifier.
    const recipients = Object.entries(roomSockets[roomId] || {}).filter(([, member]) => member.clientId === req.body.clientId).map(([id]) => id);
    const progress = current => {
      if (requestId && recipients.length) io.to(recipients).emit('pack_export_progress', { requestId, current, total: ordered.length });
    };
    progress(0);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-pack-'));
    const zip = new AdmZip();
    const title = packSafeName(room.title, 'Dubline scene');
    const videoExt = path.extname(videoPath).toLowerCase() === '.webm' ? '.webm' : '.mp4';
    zip.addLocalFile(videoPath, '', `dub_video${videoExt}`);
    zip.addFile('_pack_info.ini', Buffer.from(`[data]\ntitle=${iniQuoted(title)}\nauthors=${JSON.stringify([room.host || 'Dubline'])}\nlanguage=""\ntags="dubline"\n`, 'utf8'));

    if (backingPath && fs.existsSync(backingPath)) {
      const ext = path.extname(backingPath).toLowerCase() || '.mp3';
      zip.addLocalFile(backingPath, '', `_backing_track${ext}`);
    }

    // Lines without their own voice file are cut from the chosen "Original" track
    // (a separate video audio track if the host picked one), otherwise from the video itself.
    const tracks = Array.isArray(room.audioTracks) ? room.audioTracks : [];
    const originalTrack = tracks.length >= 2 && room.originalTrack >= 0 ? tracks[room.originalTrack] : null;
    const originalTrackPath = originalTrack ? diskPathForUrl(originalTrack.url) : null;
    const sceneAudioPath = originalTrackPath && fs.existsSync(originalTrackPath) ? originalTrackPath : videoPath;

    for (let index = 0; index < ordered.length; index++) {
      const line = ordered[index];
      const prefix = String(index + 1).padStart(Math.max(3, String(ordered.length).length), '0');
      const stem = `${prefix}_${packSafeName(line.character, 'Character')}`;
      const duration = Number((line.end - line.start).toFixed(3));
      const audioPath = path.join(tempDir, `${stem}.wav`);
      const voicePath = line.originalAudioUrl ? diskPathForUrl(line.originalAudioUrl) : null;
      try {
        if (voicePath && fs.existsSync(voicePath)) {
          // The pack's clean voice line is better than a cut from the mixed soundtrack
          await runFfmpeg(['-i', voicePath, '-t', String(duration), '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', audioPath], 'Could not convert line audio');
        } else {
          await runFfmpeg(['-ss', String(line.start), '-i', sceneAudioPath, '-t', String(duration), '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', audioPath], 'Could not extract line audio');
        }
      } catch (err) {
        await runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(duration), '-c:a', 'pcm_s16le', audioPath], 'Could not create line audio');
      }
      zip.addLocalFile(audioPath, '', `${stem}.wav`);
      const ini = `[data]\ntitle=${iniQuoted(`${line.character} ${index + 1}`)}\ncaption=${iniQuoted(line.caption)}\ndub_timestamps=[${line.start.toFixed(3)}, ${line.end.toFixed(3)}]\ndub_characters=${JSON.stringify([line.character])}\n`;
      zip.addFile(`${stem}.ini`, Buffer.from(ini, 'utf8'));
      progress(index + 1);
    }

    const archiveName = `${packSafeName(title, 'Dubline_pack')}.zip`;
    const archive = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(archiveName)}`);
    // Keep the export slot while the ZIP is being sent too: a slow connection
    // can otherwise retain one large archive while a second is built in RAM.
    if (!res.destroyed) await new Promise(resolve => {
      const done = () => {
        res.off('finish', done);
        res.off('close', done);
        resolve();
      };
      res.once('finish', done);
      res.once('close', done);
      res.send(archive);
    });
    logEvent(roomId, `📦 ${room.host || 'Host'} exported Voxalike pack "${title}" (${ordered.length} lines)`);
  } catch (err) {
    sendError(res, err);
  } finally {
    if (ownsExportSlot) packExportActive = false;
    if (tempDir && tempDir.startsWith(os.tmpdir() + path.sep)) fs.rm(tempDir, { recursive: true, force: true }, () => {});
  }
});

// Load a mod already saved on the server into the room. Host only.
app.post('/api/load-server-pack', (req, res) => {
  try {
    const { filename, room, clientId } = req.body;
    const roomId = resolveRoomId(room);
    if (!isHost(getRoom(roomId), clientId)) throw new HttpError(403, 'Only the room host can change the pack', 'error.hostOnlyPack');

    const packName = sanitizePackName(filename);
    if (!packName || packName !== filename) throw new HttpError(400, 'Invalid mod name', 'error.badPackName');

    const filePath = path.join(PACKS_DIR, packName);
    if (!fs.existsSync(filePath)) throw new HttpError(404, 'Mod not found on the server', 'error.packNotFound');

    const updatedRoom = loadPackIntoRoom(roomId, packName, fs.readFileSync(filePath), false);
    res.json({ success: true, session: publicRoom(updatedRoom) });
  } catch (err) {
    sendError(res, err);
  }
});

// Separate upload of a video (.mp4 / .mkv) and subtitles (.ass / .ssa / .srt / .vtt)
app.post('/api/upload-custom', acceptCustomFiles(MAX_PACK_MB, requireHost('Only the room host can create a scene', 'error.hostOnlyScene')), async (req, res) => {
  let targetDir = null;
  try {
    const roomId = resolveRoomId(req.query.room);
    const room = getRoom(roomId);
    if (!isHost(room, req.body.clientId)) throw new HttpError(403, 'Only the room host can create a scene', 'error.hostOnlyScene');

    const videoFile = req.files && req.files['video'] ? req.files['video'][0] : null;
    const subFile = req.files && req.files['subtitles'] ? req.files['subtitles'][0] : null;

    if (!videoFile) throw new HttpError(400, 'No video file was sent (.mp4 / .mkv)', 'error.noVideo');
    if (!isMp4File(videoFile) && !isMkvFile(videoFile)) throw new HttpError(400, 'Only .mp4 and .mkv videos are supported', 'error.videoFormat');
    if (subFile && !isSubtitleFile(subFile)) throw new HttpError(400, 'Supported subtitles: .ass, .ssa, .srt and .vtt', 'error.subtitleFormat');
    if (subFile && subFile.size > MAX_SUBTITLE_MB * 1024 * 1024) {
      throw new HttpError(413, `Subtitles are larger than ${MAX_SUBTITLE_MB} MB`, 'error.subtitlesTooBig', { max: MAX_SUBTITLE_MB });
    }

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
        if (!subtitleMap) throw new HttpError(400, 'The MKV has no embedded ASS/SSA/SRT subtitles', 'error.noEmbeddedSubtitles');
        try {
          await runFfmpeg(['-i', mkvPath, '-map', subtitleMap, '-c:s', 'ass', extractedPath], 'Could not extract embedded subtitles');
          subtitleBuffer = fs.readFileSync(extractedPath);
          subtitleName = 'embedded.ass';
          if (subtitleBuffer.length > MAX_SUBTITLE_MB * 1024 * 1024) {
            throw new HttpError(413, `Embedded subtitles are larger than ${MAX_SUBTITLE_MB} MB`, 'error.subtitlesTooBig', { max: MAX_SUBTITLE_MB });
          }
        } finally {
          fs.rmSync(extractedPath, { force: true });
        }
      }

      try {
        await runFfmpeg(['-i', mkvPath, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', videoPath], 'Could not remux MKV to MP4');
      } catch (copyError) {
        await runFfmpeg(['-i', mkvPath, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', videoPath], 'Could not remux MKV to MP4 with AAC audio');
      } finally {
        fs.rmSync(mkvPath, { force: true });
      }
    } else {
      fs.writeFileSync(videoPath, videoFile.buffer);
    }

    if (!subtitleBuffer) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      throw new HttpError(400, 'Send a subtitle file or an MKV with an embedded subtitle track', 'error.needSubtitles');
    }

    const lines = parseSubtitles(subtitleBuffer, subtitleName);
    if (!lines.length) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      throw new HttpError(400, 'No lines found in the subtitle file', 'error.noSubtitleLines');
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
    endWatch(roomId, null, '🎬 Watch-together stopped: the scene changed');
    delete p2pSeeders[roomId];

    saveRooms();
    emitSession(roomId);
    broadcastRecording(roomId);
    ensureAudioTracks(roomId);
    addSystemMessage(roomId, 'system.customScene', { title: customTitle, count: lines.length }, `🎬 The host created a new scene "${customTitle}" (${lines.length} lines)`);
    console.log(`[Dubline] Custom scene [${customTitle}] (${lines.length} lines) created in room [${roomId}]`);
    res.json({ success: true, session: publicRoom(room) });
  } catch (err) {
    if (targetDir) fs.rmSync(targetDir, { recursive: true, force: true });
    sendError(res, err);
  }
});

// Take upload
app.post('/api/upload-line-audio', acceptFile('audio', MAX_TAKE_MB, requireConfirmedNick), (req, res) => {
  try {
    const roomId = resolveRoomId(req.query.room);
    const room = getRoom(roomId);

    const lineId = parseInt(req.body.lineId, 10);
    const userName = sanitizeNick(req.body.userName);
    const audioStart = parseSeconds(req.body.audioStart);
    const trimStart = parseSeconds(req.body.trimStart);
    const trimEnd = parseSeconds(req.body.trimEnd);

    const uploadId = String(req.body.uploadId || '').slice(0, 64);
    const sessionId = String(req.body.sessionId || '');

    if (!req.file || !lineId) throw new HttpError(400, 'Invalid request', 'error.badRequest');
    if (!isAuthorized(room, userName, req.body.clientId)) throw new HttpError(403, 'Nickname not confirmed: rejoin the room', 'error.nickNotConfirmed');

    // A take may arrive late (re-sent after a dropped connection): put it into the session
    // it was recorded in, even if the host has switched to another one
    snapshotActive(room);
    const isActiveSession = !sessionId || sessionId === room.activeSessionId;
    const target = isActiveSession ? room : room.sessions[sessionId];
    if (!target) throw new HttpError(410, 'The session this take was recorded in has been deleted', 'error.sessionDeleted');
    if (target.mode === 'edit') throw new HttpError(409, 'Recording is disabled in edit mode', 'error.editMode');

    const line = target.lines.find(l => l.id === lineId);
    if (!line) throw new HttpError(404, 'Line not found', 'error.lineNotFound');

    // A repeat of the same upload (the server's reply was lost): don't store it twice
    if (uploadId && line.uploadId === uploadId && line.audioUrl) {
      return res.json({ success: true, audioUrl: line.audioUrl, audioStart: line.audioStart, duplicate: true });
    }

    const owner = target.characterClaims[line.character] || line.claimedBy || null;
    if (owner !== userName) throw new HttpError(403, 'The line is claimed by another player', 'error.lineTaken');

    const fileName = `line_${roomId}_${lineId}_${Date.now()}.webm`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fileName), req.file.buffer);

    deleteTakeFile(line.audioUrl);
    line.audioUrl = `/uploads/${encodeURIComponent(fileName)}`;
    // A line at 0:00 may include a short preparation recording before the first frame.
    line.audioStart = audioStart !== null ? Math.max(-5, audioStart) : line.start;
    line.recordedStart = line.audioStart;
    line.recordedBy = userName;
    line.uploadId = uploadId || null;
    line.blindRevealed = false;
    target.updatedAt = Date.now();
    // The chosen voice (effect/pitch) survives re-recording the take
    const hasTrim = trimStart !== null && trimEnd !== null && trimStart >= 0 && trimEnd > trimStart;
    line.trimStart = hasTrim ? trimStart : null;
    line.trimEnd = hasTrim ? trimEnd : null;
    if (line.trimEnabled === undefined) line.trimEnabled = true;
    if (!line.effect) line.effect = 'none';
    if (!line.pitch) line.pitch = 0;

    saveRooms();
    if (isActiveSession) io.to(roomId).emit('line_updated', line);
    else emitSession(roomId); // the take went to an inactive session: only refresh its progress in the list
    logEvent(roomId, `💾 ${userName} saved a take for line #${lineId} (${Math.round(req.file.size / 1024)} KB)${isActiveSession ? '' : ` to session "${target.title}"`}`);
    res.json({ success: true, audioUrl: line.audioUrl, audioStart: line.audioStart });
  } catch (err) {
    sendError(res, err);
  }
});

// Delete a take (erase a failed recording)
app.post('/api/delete-line-audio', (req, res) => {
  try {
    const { lineId, userName, clientId } = req.body;
    const roomId = resolveRoomId(req.body.room);
    const room = getRoom(roomId);

    const line = room.lines.find(l => l.id === parseInt(lineId, 10));
    if (!line) throw new HttpError(404, 'Line not found', 'error.lineNotFound');

    const nick = sanitizeNick(userName);
    const owner = getLineOwner(room, line);
    if (!isAuthorized(room, nick, clientId) || (owner && owner !== nick)) {
      throw new HttpError(403, "You cannot delete someone else's take", 'error.notYourTake');
    }

    deleteTakeFile(line.audioUrl);
    const { effect, pitch, trimEnabled } = line;
    Object.assign(line, emptyTake(), { effect: effect || 'none', pitch: pitch || 0, trimEnabled: trimEnabled !== false });

    saveRooms();
    io.to(roomId).emit('line_updated', line);
    logEvent(roomId, `🗑 ${nick} deleted the take for line #${line.id}`);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});
