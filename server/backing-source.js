// Replace the separate background; embedded source choices remain independent.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { app, io } = require('./app');
const { rooms, roomSockets, p2pSeeders } = require('./state');
const { UPLOAD_DIR, MAX_VIDEO_MB, HttpError } = require('./config');
const { resolveRoomId } = require('./desktop');
const { isHost } = require('./auth');
const { snapshotActive, saveRooms, emitSession, publicRoom } = require('./rooms');
const { runFfmpeg, probeAudioDuration } = require('./media');
const { forgetFileSizes } = require('./files');
const { diskUpload } = require('./project-uploads');
const jobs = new Map();
const baseSource = room => room.baseBackingUrl ?? (room.backingTrack >= 0 ? '' : room.backingUrl || '');
function check(req) {
  const roomId = resolveRoomId(req.query.room), room = rooms[roomId], data = req.body || {};
  const members = Object.entries(roomSockets[roomId] || {}).filter(([, value]) => value.nick && value.clientId === data.clientId);
  if (!room || !isHost(room, data.clientId) || !members.length) throw new HttpError(403, 'Only the connected host may change background audio', 'onlyHost');
  if (!room.loaded || data.sessionId !== room.activeSessionId) throw new HttpError(409, 'Scene changed', 'error.importSceneChanged');
  if (data.baseBackingUrl !== baseSource(room) || data.backingUrl !== (room.backingUrl || '') || Number(data.backingTrack) !== (room.backingTrack ?? -1)) throw new HttpError(409, 'Audio sources changed', 'backing.changed');
  if (require('./snapshotBarrier').frozenClient(roomId, room.activeSessionId, data.clientId)) throw new HttpError(409, 'Snapshot is being prepared', 'snapshot.frozen');
  return { roomId, room, members };
}
function acquire(req, res) {
  const state = check(req);
  if (req.backingJob) return state;
  if (jobs.has(state.roomId) || jobs.size >= 2) throw new HttpError(409, 'Background processing is busy', 'project.busy');
  const token = {}; req.backingJob = token; jobs.set(state.roomId, token);
  const release = () => { if (jobs.get(state.roomId) === token) jobs.delete(state.roomId); };
  res.once('finish', release); res.once('close', release);
  req.backingDisconnects = state.members.map(([id]) => {
    const socket = io.sockets.sockets.get(id);
    const disconnected = () => {
      if (!Object.values(roomSockets[state.roomId] || {}).some(value => value.clientId === req.body.clientId && value.nick)) req.uploadAbort?.abort();
    };
    socket?.once('disconnect', disconnected); return () => socket?.off('disconnect', disconnected);
  });
  const cleanup = () => req.backingDisconnects.forEach(remove => remove());
  res.once('finish', cleanup); res.once('close', cleanup);
  return state;
}
function removeUnused(url) {
  if (!/^\/uploads\/backing_[a-f0-9-]+\/backing\.m4a$/.test(url || '')) return;
  const used = Object.values(rooms).some(room => [room, ...Object.values(room.sessions || {})].some(scene =>
    [scene.videoUrl, scene.originalVideoUrl, scene.backingUrl, scene.baseBackingUrl, scene.externalOriginalUrl, ...(scene.audioTracks || []).map(value => value.url), ...(scene.lines || []).flatMap(value => [value.audioUrl, value.originalAudioUrl])].includes(url)));
  if (used) return;
  const directory = path.resolve(UPLOAD_DIR, url.split('/')[2]);
  if (!directory.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return;
  try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch { console.warn('[Dubline] Previous background cleanup deferred'); }
}
function commit(roomId, room, url, metadata, remove = false) {
  const old = baseSource(room);
  room.baseBackingUrl = url;
  if (!remove) room.backingTrack = -1;
  room.backingUrl = room.backingTrack >= 0 ? room.audioTracks[room.backingTrack].url : url;
  room.audioMetadata = { ...(room.audioMetadata || {}) };
  if (metadata) room.audioMetadata.backing = metadata; else delete room.audioMetadata.backing;
  room.updatedAt = Date.now(); snapshotActive(room); saveRooms();
  forgetFileSizes(old, url); delete p2pSeeders[roomId]; emitSession(roomId); removeUnused(old);
}
function fail(res, error) {
  if (res.destroyed) return;
  const known = error instanceof HttpError;
  res.status(known ? error.status : error.name === 'AbortError' ? 409 : 400).json({ key: known ? error.key : error.name === 'AbortError' ? 'error.importSceneChanged' : 'error.processingFailed', params: error.params || {} });
}
app.post('/api/backing-source', (req, res, next) => {
  req.backingResponse = res; next();
}, diskUpload(['intershum'], (req, file) => {
  if (!/\.(wav|mp3|m4a|aac|ogg|oga|opus|flac)$/i.test(file.originalname)) throw new HttpError(400, 'Unsupported audio format', 'error.audioFormat');
  acquire(req, req.backingResponse);
}, { maxFileBytes: MAX_VIDEO_MB * 1024 * 1024 }), async (req, res) => {
  let directory, retained = false;
  try {
    const { roomId } = acquire(req, res);
    if (!req.file) throw new HttpError(400, 'No background audio file', 'error.audioInvalid');
    const name = 'backing_' + crypto.randomUUID(); directory = path.join(UPLOAD_DIR, name); fs.mkdirSync(directory);
    const output = path.join(directory, 'backing.m4a'), url = `/uploads/${name}/backing.m4a`;
    await runFfmpeg(['-i', req.file.path, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output], 'Could not prepare background audio', { signal: req.uploadAbort.signal });
    const duration = probeAudioDuration(output);
    if (!duration || duration > 86400) throw new HttpError(400, 'No readable audio samples', 'error.audioInvalid');
    req.uploadAbort.signal.throwIfAborted();
    const { room } = check(req);
    const metadata = { name: path.basename(req.file.originalname).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200), duration, size: fs.statSync(output).size };
    retained = true; commit(roomId, room, url, metadata);
    res.json({ success: true, session: publicRoom(room) });
  } catch (error) { fail(res, error); }
  finally {
    req.backingDisconnects?.forEach(remove => remove());
    if (directory && !retained && path.resolve(directory).startsWith(path.resolve(UPLOAD_DIR) + path.sep)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
app.post('/api/backing-source/remove', (req, res) => {
  try {
    const { roomId, room } = check(req);
    if (jobs.has(roomId)) throw new HttpError(409, 'Background processing is busy', 'project.busy');
    if (!baseSource(room)) throw new HttpError(409, 'The background was already removed', 'backing.changed');
    commit(roomId, room, '', null, true); res.json({ success: true, session: publicRoom(room) });
  } catch (error) { fail(res, error); }
});
module.exports = { isBusy: () => jobs.size > 0 };
