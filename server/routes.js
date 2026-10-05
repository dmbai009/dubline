const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, UPLOAD_DIR, PACKS_DIR, MAX_VIDEO_MB, MAX_PACK_MB, MAX_PACK_EXPORT_MB, MAX_EXPORT_LINE_SECONDS, MAX_TAKE_MB, MAX_SUBTITLE_MB, HttpError } = require('./config');
const { rooms, recordingNow, p2pSeeders, roomSockets } = require('./state');
const { app, io } = require('./app');
const { sanitizeNick, sanitizePackName } = require('./sanitize');
const { resolveRoomId, clientIdFromCookie } = require('./desktop');
const { logEvent } = require('./log');
const { forgetFileSizes, deleteTakeFile, diskPathForUrl } = require('./files');
const { runFfmpeg, findEmbeddedSubtitleMap } = require('./media');
const { emptyTake, parseSeconds, readPack, isMkvFile, isMp4File, isSubtitleFile, parseSubtitles } = require('./parsers');
const { saveRooms, flushRooms, getRoom, snapshotActive, startNewSession, publicRoom, emitSession, ensureAudioTracks } = require('./rooms');
const { endWatch, broadcastRecording, addSystemMessage } = require('./presence');
const { isAuthorized, isHost, getLineOwner } = require('./auth');
const { parseWorkshopUrl, downloadVoxalikePack } = require('./workshop');
const { exportProjectDisk, stageProjectDisk } = require('./project-archive');
const { diskUpload } = require('./project-uploads');
const { pipeline } = require('node:stream/promises');

const workshopDownloads = new Map();
// Pack exports in progress, by room. One per room; at most two on the whole server because
// every export builds its ZIP in memory (the browser server can host several rooms).
const packExports = new Set();
const MAX_PARALLEL_PACK_EXPORTS = 2;
const projectExports = new Set();
const projectImports = new Set();
const customImports = new Set();
const projectDownloads = new Map();

app.get('/api/audio-waveform', async (req, res) => {
  // Look the room up without creating it: a GET with a made-up name must not add rooms
  const roomId = resolveRoomId(req.query.room);
  if (!rooms[roomId]) return res.status(404).json({ error: 'No such room' });
  const room = getRoom(roomId);
  if (!room.loaded || req.query.sessionId !== room.activeSessionId) return res.status(409).json({ error: 'Scene changed' });
  const sources = require('../public/project-audio').sources(room);
  const url = ['original', 'backing'].includes(req.query.channel) && sources[req.query.channel];
  if (!url) return res.status(404).json({ error: 'No audio source' });
  try {
    const result = await require('./waveform').waveform(url);
    res.json({ ...result, sessionId: req.query.sessionId, source: url });
  } catch (error) {
    // A silent video is a valid scene; it simply has no original waveform.
    res.status(422).json({ error: 'No readable audio', sessionId: req.query.sessionId, source: url });
  }
});

// ==========================================
// HTTP API
// ==========================================

function loadPackIntoRoom(roomId, packName, buffer, preparedPack) {
  const room = getRoom(roomId);
  const pack = preparedPack || readPack(buffer, packName);

  // A new pack starts a new session: earlier sessions and their takes are kept
  startNewSession(room, {
    title: pack.title,
    kind: 'pack',
    zipUrl: pack.zipUrl,
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

// Pre-upgrade scenes may still point at a mutable library filename.
// Preserve that archive before replacing the library entry, including other rooms.
function preserveLegacyPackSources(packName) {
  const legacyUrl = `/packs/${encodeURIComponent(packName)}`;
  const affected = Object.entries(rooms).filter(([, room]) =>
    [room, ...Object.values(room.sessions || {})].some(scene => scene.zipUrl === legacyUrl));
  const libraryPath = path.join(PACKS_DIR, packName);
  if (!affected.length || !fs.existsSync(libraryPath)) return;
  const buffer = fs.readFileSync(libraryPath);
  const fileName = `pack_source_${crypto.createHash('sha256').update(buffer).digest('hex')}.zip`;
  const archivePath = path.join(UPLOAD_DIR, fileName);
  if (!fs.existsSync(archivePath)) fs.writeFileSync(archivePath, buffer, { flag: 'wx' });
  for (const [roomId, room] of affected) {
    for (const scene of [room, ...Object.values(room.sessions || {})]) {
      if (scene.zipUrl === legacyUrl) scene.zipUrl = `/uploads/${fileName}`;
    }
    emitSession(roomId);
  }
  saveRooms();
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

// Multipart boundaries, headers and the text fields around the files
const MULTIPART_OVERHEAD = 1024 * 1024;

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
    const pack = readPack(req.file.buffer, packName);
    preserveLegacyPackSources(packName);
    const libraryPath = path.join(PACKS_DIR, packName);
    const tmpPath = libraryPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, req.file.buffer);
      fs.renameSync(tmpPath, libraryPath);
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
    const updatedRoom = loadPackIntoRoom(roomId, packName, req.file.buffer, pack);
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
    const importSessionId = room.activeSessionId;

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

    if (res.destroyed || room.activeSessionId !== importSessionId || !isHost(room, req.body.clientId)) throw new HttpError(409, 'The scene changed during import', 'error.importSceneChanged');
    const pack = readPack(buffer, source.filename);
    if (!cached) {
      try {
        fs.writeFileSync(filePath, buffer, { flag: 'wx' });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        cached = true;
      }
    }
    const updatedRoom = loadPackIntoRoom(roomId, source.filename, buffer, pack);
    updatedRoom.workshopSource = {
      downloadUrl: source.downloadUrl, archiveSize: buffer.length,
      archiveHash: crypto.createHash('sha256').update(buffer).digest('hex'),
      videoEntry: decodeURIComponent(pack.videoUrl.split('/').pop()),
      backingEntry: pack.backingUrl ? decodeURIComponent(pack.backingUrl.split('/').pop()) : ''
    };
    flushRooms(); emitSession(roomId);
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

// The same project routes serve all runtime modes. Binding the request to a session
// prevents a delayed save/open from silently operating on a different active scene.
function projectFilename(title) {
  return String(title || 'Dubline_project').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').slice(0,120)+'.dubline';
}
async function sendProjectFile(res,saved,filename) {
  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(filename));
  res.setHeader('Content-Length',saved.bytes);
  await pipeline(fs.createReadStream(saved.path),res);
}
app.post('/api/export-project', async (req,res)=>{
  let ownsSlot,saved;const abort=new AbortController();
  res.once('close',()=>{if(!res.writableFinished)abort.abort();});
  try{
    const roomId=resolveRoomId(req.body.room),room=getRoom(roomId);
    if(!isHost(room,req.body.clientId))throw new HttpError(403,'Only the host can save a project','onlyHost');
    if(req.body.sessionId!==room.activeSessionId)throw new HttpError(409,'The scene changed','error.importSceneChanged');
    if(projectExports.has(roomId)||projectExports.size>=2)throw new HttpError(409,'A project save is in progress','project.busy');
    projectExports.add(roomId);ownsSlot=roomId;
    saved=await exportProjectDisk(room,undefined,{signal:abort.signal});
    if(!isHost(room,req.body.clientId))throw new HttpError(403,'Host rights changed','onlyHost');
    if(res.destroyed)return;
    const filename=projectFilename(saved.title);
    if(req.body.download===true){
      const ticket=crypto.randomUUID(),archive=saved;
      const release=async()=>{projectDownloads.delete(ticket);projectExports.delete(roomId);await archive.cleanup();};
      const timer=setTimeout(()=>{void release().catch(error=>console.error('[Dubline] Project cleanup:',error.message));},5*60*1000);timer.unref();
      projectDownloads.set(ticket,{archive,roomId,clientId:req.body.clientId,filename,timer,release});
      saved=null;ownsSlot=null;
      res.json({downloadUrl:'/api/download-project?ticket='+ticket,filename,bytes:archive.bytes});
    }else await sendProjectFile(res,saved,filename);
  }catch(error){if(!res.destroyed&&!res.headersSent)sendError(res,error);}
  finally{if(saved)await saved.cleanup();if(ownsSlot)projectExports.delete(ownsSlot);}
});
app.get('/api/download-project',async(req,res)=>{
  const job=projectDownloads.get(req.query.ticket);
  if(!job)return sendJsonError(res,404,'The prepared download expired','project.downloadExpired');
  if(clientIdFromCookie(req.headers.cookie)!==job.clientId||!isHost(getRoom(job.roomId),job.clientId))return sendJsonError(res,403,'Only the host can download this project','onlyHost');
  projectDownloads.delete(req.query.ticket);clearTimeout(job.timer);
  try{await sendProjectFile(res,job.archive,job.filename);}
  catch(error){if(!res.destroyed&&!res.headersSent)sendError(res,error);}
  finally{await job.release();}
});

async function importProjectIntoRoom(roomId, archivePath, authorize = () => true, signal) {
  const room = getRoom(roomId), sessionId = room.activeSessionId;
  if (projectImports.has(roomId) || projectImports.size >= 2) throw new HttpError(409, 'A project open is in progress', 'project.busy');
  projectImports.add(roomId);
  let staged, committed = false;
  try {
    if (!authorize()) throw new HttpError(409, 'The scene changed', 'error.importSceneChanged');
    staged = await stageProjectDisk(archivePath, UPLOAD_DIR, { authorize, signal });
    for (const file of staged.mediaFiles) {
      const args = file.video ? ['-map', '0:v:0', '-frames:v', '1', '-an'] : ['-map', '0:a:0', '-frames:a', '1', '-vn'];
      try { await runFfmpeg(['-i', file.path, ...args, '-f', 'null', '-'], 'Could not read project media', {signal}); }
      catch { if(signal?.aborted)signal.throwIfAborted(); throw new HttpError(400, 'Unreadable project media', 'project.invalid'); }
      if (room.activeSessionId !== sessionId || !authorize()) throw new HttpError(409, 'The scene changed during import', 'error.importSceneChanged');
    }
    const videoFile = staged.mediaFiles.find(file => file.primary);
    const duration = require('./media').probeAudioDuration(videoFile.path);
    if (!duration || staged.fields.lines.some(line => !require('../public/timeline-model').valid(line.start, line.end, duration, Math.min(0.1, line.end - line.start)))) throw new HttpError(400, 'Project lines exceed video duration', 'project.invalid');
    const sourceFile = staged.mediaFiles.find(file => file.video && !file.primary);
    if (sourceFile && Math.abs(require('./media').probeAudioDuration(sourceFile.path) - duration) > 0.25) throw new HttpError(400, 'Original/proxy duration differs', 'project.invalid');
    staged.fields.videoDuration = duration;
    startNewSession(room, staged.commit()); committed = true;
    delete recordingNow[roomId]; delete p2pSeeders[roomId];
    endWatch(roomId, null, 'Watch-together stopped: a project was opened');
    flushRooms(); emitSession(roomId); broadcastRecording(roomId); ensureAudioTracks(roomId);
    logEvent(roomId, 'Project opened: ' + room.title);
    return room;
  } finally {
    if (!committed) staged?.rollback();
    projectImports.delete(roomId);
  }
}
module.exports.importProjectIntoRoom = importProjectIntoRoom;
app.post('/api/import-project', diskUpload(['project'], requireHost('Only the host can open a project', 'onlyHost')), async (req, res) => {
  try {
    const roomId = resolveRoomId(req.query.room), room = getRoom(roomId);
    if (!isHost(room, req.body.clientId)) throw new HttpError(403, 'Only the host can open a project', 'onlyHost');
    if (req.body.sessionId !== (room.activeSessionId || '')) throw new HttpError(409, 'The scene changed', 'error.importSceneChanged');
    if (!req.file) throw new HttpError(400, 'No project file', 'error.noFile');
    const updated = await importProjectIntoRoom(roomId, req.file.path, () => !res.destroyed && isHost(room, req.body.clientId), req.uploadAbort.signal);
    res.json({ success: true, session: publicRoom(updated) });
  } catch (error) { if (!res.destroyed) sendError(res, error); }
});

// Build a standard Voxalike pack from the edited timeline. Host only because FFmpeg work
// happens on the host machine and can be expensive for a long scene.
app.post('/api/export-voxalike-pack', async (req, res) => {
  let tempDir = null;
  let ownsExportSlot = null;
  let clientGone = false;
  try {
    const roomId = resolveRoomId(req.body.room);
    const room = getRoom(roomId);
    if (!isHost(room, req.body.clientId)) throw new HttpError(403, 'Only the room host can export a pack', 'error.hostOnlyPack');
    if (packExports.has(roomId) || packExports.size >= MAX_PARALLEL_PACK_EXPORTS) throw new HttpError(409, 'Another pack export is in progress on this host', 'error.packExportBusy');
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

    packExports.add(roomId);
    ownsExportSlot = roomId;
    // The host closed the tab or the tunnel dropped: stop instead of building a ZIP nobody gets
    res.on('close', () => { if (!res.writableFinished) clientGone = true; });
    const requestId = typeof req.body.requestId === 'string' ? req.body.requestId.slice(0, 80) : '';
    // Notify only the requesting host's windows, with a per-export identifier.
    const recipients = Object.entries(roomSockets[roomId] || {}).filter(([, member]) => member.clientId === req.body.clientId).map(([id]) => id);
    const progress = current => {
      if (requestId && recipients.length) io.to(recipients).emit('pack_export_progress', { requestId, current, total: ordered.length });
    };
    progress(0);
    tempDir = fs.mkdtempSync(path.join(DATA_DIR, '.pack-export-'));
    const zip = new AdmZip();
    const title = String(room.title || 'Dubline scene');
    const videoExt = path.extname(videoPath).toLowerCase() === '.webm' ? '.webm' : '.mp4';
    zip.addLocalFile(videoPath, '', `dub_video${videoExt}`);
    zip.addFile('_pack_info.ini', Buffer.from(`[data]\ntitle=${iniQuoted(title)}\nauthors=${JSON.stringify([room.host || 'Dubline'])}\nlanguage=""\ntags="dubline"\n`, 'utf8'));

    if (backingPath && fs.existsSync(backingPath)) {
      const ext = path.extname(backingPath).toLowerCase() || '.mp3';
      zip.addLocalFile(backingPath, '', `_backing_track${ext}`);
    }

    // Lines without their own voice file are cut from the chosen "Original" track
    // (a separate video audio track if the host picked one), otherwise from the video itself.
    const projectMix = require('../public/project-audio').normalize(room);
    const originalSource = require('../public/project-audio').sources(room).original;
    const originalTrackPath = originalSource ? diskPathForUrl(originalSource) : null;
    const sceneAudioPath = originalTrackPath && fs.existsSync(originalTrackPath) ? originalTrackPath : videoPath;

    for (let index = 0; index < ordered.length; index++) {
      if (clientGone) throw new HttpError(499, 'The pack export was cancelled: the host disconnected', 'error.packExportCancelled');
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
          const sourceStart = line.start - projectMix.original.offset;
          const leadMs = Math.round(Math.max(0, -sourceStart) * 1000);
          if (leadMs >= duration * 1000) throw new Error('The reference starts after this line');
          await runFfmpeg(['-ss', String(Math.max(0, sourceStart)), '-i', sceneAudioPath, '-af', `adelay=${leadMs}:all=1,apad`, '-t', String(duration), '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', audioPath], 'Could not extract line audio');
        }
      } catch (err) {
        await runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(duration), '-c:a', 'pcm_s16le', audioPath], 'Could not create line audio');
      }
      zip.addLocalFile(audioPath, '', `${stem}.wav`);
      const ini = `[data]\ntitle=${iniQuoted(`${line.character} ${index + 1}`)}\ncaption=${iniQuoted(line.caption)}\ndub_timestamps=[${line.start.toFixed(3)}, ${line.end.toFixed(3)}]\ndub_characters=${JSON.stringify([line.character])}\n`;
      zip.addFile(`${stem}.ini`, Buffer.from(ini, 'utf8'));
      progress(index + 1);
    }

    if (clientGone) throw new HttpError(499, 'The pack export was cancelled: the host disconnected', 'error.packExportCancelled');
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
    if (clientGone) {
      logEvent(resolveRoomId(req.body.room), '📦 Voxalike pack export cancelled: the host disconnected');
      return;
    }
    sendError(res, err);
  } finally {
    if (ownsExportSlot) packExports.delete(ownsExportSlot);
    if (tempDir && path.dirname(tempDir) === DATA_DIR && path.basename(tempDir).startsWith('.pack-export-')) fs.rm(tempDir, { recursive: true, force: true }, () => {});
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

    const updatedRoom = loadPackIntoRoom(roomId, packName, fs.readFileSync(filePath));
    res.json({ success: true, session: publicRoom(updatedRoom) });
  } catch (err) {
    sendError(res, err);
  }
});

// Separate upload of a video (.mp4 / .mkv) and subtitles (.ass / .ssa / .srt / .vtt)
app.post('/api/upload-custom', (req,res,next) => {
  const roomId = resolveRoomId(req.query.room);
  req.importSessionId = getRoom(roomId).activeSessionId;
  const release = () => { if(req.customImportSlot === roomId) customImports.delete(roomId); };
  res.once('finish',release); res.once('close',release);
  next();
}, diskUpload(['video','subtitles','original','intershum'], req => {
  requireHost('Only the room host can create a scene','error.hostOnlyScene')(req);
  if(req.customImportSlot)return;
  const roomId=resolveRoomId(req.query.room);
  if(customImports.has(roomId) || customImports.size >= 2) throw new HttpError(409,'An import is already in progress','project.busy');
  customImports.add(roomId); req.customImportSlot=roomId;
}), async (req, res) => {
  let targetDir = null;
  try {
    const roomId = resolveRoomId(req.query.room);
    const room = getRoom(roomId);
    if (!isHost(room, req.body.clientId)) throw new HttpError(403, 'Only the room host can create a scene', 'error.hostOnlyScene');

    const videoFile = req.files && req.files['video'] ? req.files['video'][0] : null;
    const subFile = req.files && req.files['subtitles'] ? req.files['subtitles'][0] : null;
    const originalFile = req.files && req.files.original ? req.files.original[0] : null;
    const intershumFile = req.files && req.files.intershum ? req.files.intershum[0] : null;
    const importSessionId = req.importSessionId;
    const requestId = String(req.body.requestId || '').slice(0,80);
    const recipients = Object.entries(roomSockets[roomId] || {}).filter(([,member]) => member.clientId === req.body.clientId).map(([id]) => id);
    let progressAt = 0;
    const progress = (stage, percent) => {
      if (Date.now() - progressAt < 300 && percent !== 0 && percent !== 100) return;
      progressAt = Date.now();
      if (requestId && recipients.length) io.to(recipients).emit('video_import_progress',{requestId,stage,percent});
    };
    for (const audio of [originalFile, intershumFile].filter(Boolean)) {
      if (!/\.(wav|mp3|m4a|aac|ogg|oga|opus|flac)$/i.test(audio.originalname)) throw new HttpError(400, 'Unsupported audio file', 'error.audioFormat');
    }

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
    let subtitleBuffer = subFile ? fs.readFileSync(subFile.path) : null;
    let subtitleName = subFile ? subFile.originalname : '';

    let originalVideoUrl = '', originalVideoName = '', proxy = null;
    if (req.query.optimize === '1') {
      const sourceName = 'source_video' + (isMkvFile(videoFile) ? '.mkv' : '.mp4');
      const sourcePath = path.join(targetDir, sourceName);
      require('./video-proxy').checkSpace(targetDir,videoFile.size + MAX_VIDEO_MB * 1024 * 1024);
      fs.copyFileSync(videoFile.path,sourcePath);
      if (isMkvFile(videoFile) && !subtitleBuffer) {
        const map = findEmbeddedSubtitleMap(sourcePath), extracted = path.join(targetDir,'embedded.ass');
        if (map) try {
          await runFfmpeg(['-i',sourcePath,'-map',map,'-c:s','ass',extracted],'Could not extract embedded subtitles',{signal:req.uploadAbort.signal});
          if (fs.statSync(extracted).size > MAX_SUBTITLE_MB * 1024 * 1024) throw new HttpError(413,'Embedded subtitles exceed the limit','error.subtitlesTooBig',{max:MAX_SUBTITLE_MB});
          subtitleBuffer=fs.readFileSync(extracted); subtitleName='embedded.ass';
        } finally {fs.rmSync(extracted,{force:true});}
      }
      const videoUrl = '/uploads/' + dirName + '/' + videoName;
      proxy = await require('./video-proxy').createVideoProxy(sourcePath,videoPath,videoUrl,{signal:req.uploadAbort.signal,progress});
      originalVideoUrl = '/uploads/' + dirName + '/' + sourceName;
      originalVideoName = path.basename(videoFile.originalname).slice(0,200);
    } else if (isMkvFile(videoFile)) {
      const mkvPath = path.join(targetDir, 'source.mkv');
      fs.copyFileSync(videoFile.path, mkvPath);

      if (!subtitleBuffer) {
        const extractedPath = path.join(targetDir, 'embedded.ass');
        const subtitleMap = findEmbeddedSubtitleMap(mkvPath);
        if (subtitleMap) try {
          await runFfmpeg(['-i', mkvPath, '-map', subtitleMap, '-c:s', 'ass', extractedPath], 'Could not extract embedded subtitles', {signal:req.uploadAbort.signal});
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
        await runFfmpeg(['-i', mkvPath, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', videoPath], 'Could not remux MKV to MP4', {signal:req.uploadAbort.signal});
      } catch (copyError) {
        await runFfmpeg(['-i', mkvPath, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', videoPath], 'Could not remux MKV to MP4 with AAC audio', {signal:req.uploadAbort.signal});
      } finally {
        fs.rmSync(mkvPath, { force: true });
      }
    } else {
      fs.copyFileSync(videoFile.path, videoPath);
      await runFfmpeg(['-i', videoPath, '-map', '0:v:0', '-frames:v', '1', '-an', '-f', 'null', '-'], 'Could not read scene video', {signal:req.uploadAbort.signal});
    }

    if (fs.statSync(videoPath).size > MAX_VIDEO_MB * 1024 * 1024) throw new HttpError(413, 'Converted video exceeds the video limit', 'error.videoTooBig', {max:MAX_VIDEO_MB});
    const lines = subtitleBuffer ? parseSubtitles(subtitleBuffer, subtitleName) : [];
    if (subtitleBuffer && !lines.length) {
      throw new HttpError(400, 'No lines found in the subtitle file', 'error.noSubtitleLines');
    }

    const audioMetadata = {};
    const externalUrls = {};
    for (const [channel, file] of [['original', originalFile], ['backing', intershumFile]]) {
      if (!file) continue;
      const sourcePath = path.join(targetDir, `${channel}_source${path.extname(file.originalname).toLowerCase()}`);
      const outputName = `${channel}.m4a`;
      const outputPath = path.join(targetDir, outputName);
      fs.copyFileSync(file.path, sourcePath);
      await runFfmpeg(['-i', sourcePath, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath], 'Could not read external audio', {signal:req.uploadAbort.signal});
      fs.rmSync(sourcePath, { force: true });
      const { probeAudioDuration } = require('./media');
      const duration = probeAudioDuration(outputPath);
      if (!duration) throw new HttpError(400, 'Audio has no readable samples', 'error.audioInvalid');
      externalUrls[channel] = `/uploads/${encodeURIComponent(dirName)}/${outputName}`;
      audioMetadata[channel] = { name: path.basename(file.originalname).slice(0, 200), duration, size: fs.statSync(outputPath).size };
    }
    // A long remux/convert may have outlived a session switch or a host change.
    if (res.destroyed || room.activeSessionId !== importSessionId || !isHost(room, req.body.clientId)) throw new HttpError(409, 'The scene changed during import', 'error.importSceneChanged');

    startNewSession(room, {
      title: customTitle,
      originalVideoUrl, originalVideoName,
      ...(proxy ? {videoDuration:proxy.duration, audioTracks:proxy.tracks, videoHasAudio:proxy.tracks.length > 0} : {}),
      kind: 'custom',
      zipUrl: '',
      videoUrl: `/uploads/${encodeURIComponent(dirName)}/${encodeURIComponent(videoName)}`,
      backingUrl: externalUrls.backing || '',
      externalOriginalUrl: externalUrls.original || '',
      audioMetadata,
      mode: subtitleBuffer ? 'dub' : 'edit',
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
    if (lines.skippedTimings) {
      addSystemMessage(roomId, 'system.subtitlesSkipped', { n: lines.skippedTimings }, `⚠ ${lines.skippedTimings} subtitle lines were skipped: their time is missing, reversed or zero-length`);
    }
    console.log(`[Dubline] Custom scene [${customTitle}] (${lines.length} lines) created in room [${roomId}]`);
    res.json({ success: true, skippedTimings: lines.skippedTimings || 0, session: publicRoom(room) });
  } catch (err) {
    if (targetDir) fs.rmSync(targetDir, { recursive: true, force: true, maxRetries:10, retryDelay:100 });
    if (!res.destroyed) sendError(res, ['ENOSPC','EDQUOT'].includes(err.code) ? new HttpError(507,'Not enough disk space','project.diskSpace') : err);
  }
});
require('./video-export');

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
    const takeSequence = Number(req.body.takeSequence);

    if (!req.file || !lineId) throw new HttpError(400, 'Invalid request', 'error.badRequest');
    if (!isAuthorized(room, userName, req.body.clientId)) throw new HttpError(403, 'Nickname not confirmed: rejoin the room', 'error.nickNotConfirmed');

    // A take may arrive late (re-sent after a dropped connection): put it into the session
    // it was recorded in, even if the host has switched to another one
    snapshotActive(room);
    if (!sessionId) throw new HttpError(400, 'Missing recording session', 'error.badRequest');
    const isActiveSession = sessionId === room.activeSessionId;
    const target = isActiveSession ? room : room.sessions[sessionId];
    if (!target) throw new HttpError(410, 'The session this take was recorded in has been deleted', 'error.sessionDeleted');
    if (target.mode === 'edit') throw new HttpError(409, 'Recording is disabled in edit mode', 'error.editMode');

    const line = target.lines.find(l => l.id === lineId);
    if (!line) throw new HttpError(404, 'Line not found', 'error.lineNotFound');

    const owner = room.singlePlayer ? room.host : getLineOwner(target, line);
    if (owner !== userName) throw new HttpError(403, 'The line is claimed by another player', 'error.lineTaken');
    if (!uploadId || !Number.isSafeInteger(takeSequence) || takeSequence < 1 || takeSequence > (line.takeCounter || 0)) {
      throw new HttpError(400, 'Invalid take reservation', 'error.badRequest');
    }
    // Retrying an old upload, including after deletion, must never resurrect it.
    if (takeSequence <= (line.takeSequence || 0)) {
      const duplicate = takeSequence === line.takeSequence && line.uploadId === uploadId && !!line.audioUrl;
      return res.json({ success: true, audioUrl: line.audioUrl, audioStart: line.audioStart, duplicate, superseded: !duplicate });
    }

    const fileName = `line_${roomId}_${lineId}_${crypto.randomUUID()}.webm`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fileName), req.file.buffer);

    deleteTakeFile(line.audioUrl);
    line.audioUrl = `/uploads/${encodeURIComponent(fileName)}`;
    // A line at 0:00 may include a short preparation recording before the first frame.
    line.audioStart = audioStart !== null ? Math.max(-5, audioStart) : line.start;
    line.recordedStart = line.audioStart;
    line.recordedBy = userName;
    line.uploadId = uploadId || null;
    line.takeSequence = takeSequence;
    line.blindRevealed = false;
    target.updatedAt = Date.now();
    // The chosen voice (effect/pitch) survives re-recording the take
    const hasTrim = trimStart !== null && trimEnd !== null && trimStart >= 0 && trimEnd > trimStart;
    line.trimStart = hasTrim ? trimStart : null;
    line.trimEnd = hasTrim ? trimEnd : null;
    if (line.trimEnabled === undefined) line.trimEnabled = true;
    if (!line.effect) line.effect = 'none';
    if (!line.pitch) line.pitch = 0;

    flushRooms();
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

    if (req.body.sessionId !== room.activeSessionId) throw new HttpError(409, 'The scene changed', 'error.takeChanged');
    const line = room.lines.find(l => l.id === parseInt(lineId, 10));
    if (!line) throw new HttpError(404, 'Line not found', 'error.lineNotFound');

    const nick = sanitizeNick(userName);
    const owner = getLineOwner(room, line);
    if (!isAuthorized(room, nick, clientId) || !(isHost(room, clientId) || owner === nick || (!owner && line.recordedBy === nick))) {
      throw new HttpError(403, "You cannot delete someone else's take", 'error.notYourTake');
    }
    if (!Object.hasOwn(req.body, 'audioUrl') || req.body.audioUrl !== line.audioUrl) throw new HttpError(409, 'The take changed', 'error.takeChanged');

    deleteTakeFile(line.audioUrl);
    const { effect, pitch, trimEnabled, volume = 1, pan = 0, effectAmount = 1 } = line;
    Object.assign(line, emptyTake(), { effect: effect || 'none', pitch: pitch || 0, trimEnabled: trimEnabled !== false, volume, pan, effectAmount });

    flushRooms();
    io.to(roomId).emit('line_updated', line);
    logEvent(roomId, `🗑 ${nick} deleted the take for line #${line.id}`);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});
