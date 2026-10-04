const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, ROOMS_FILE } = require('./config');
const { rooms } = require('./state');
const { io } = require('./app');
const { logEvent } = require('./log');
const { sceneDirOf, diskPathForUrl, fileSizeForUrl, fileHashForUrl, deleteTakeFile } = require('./files');
const { extractAudioTracks, probeAudioDuration, getWavDuration } = require('./media');
const { isAssDrawing, cleanAssText } = require('./parsers');
const projectAudio = require('../public/project-audio');

// ==========================================
// ROOMS (persisted to disk)
// ==========================================
// Scene fields that belong to a session (see "Sessions" below)
const SESSION_FIELDS = ['loaded', 'title', 'kind', 'zipUrl', 'videoUrl', 'backingUrl', 'lines', 'characterClaims', 'createdAt', 'updatedAt',
  'audioTracks', 'originalTrack', 'backingTrack', 'baseBackingUrl', 'deletedLines', 'mode', 'trackOrder', 'nextLineId', 'blindMode',
  'externalOriginalUrl', 'audioMetadata', 'projectAudio', 'videoHasAudio'];
let repairedOnLoad = false;

function loadRooms() {
  try {
    if (fs.existsSync(ROOMS_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')) || {};
      // After reading JSON, the active session fields and its entry in sessions are different objects: link them back
      for (const room of Object.values(loaded)) {
        const active = room.sessions && room.activeSessionId && room.sessions[room.activeSessionId];
        if (active) SESSION_FIELDS.forEach(field => { room[field] = active[field]; });
        [room, ...Object.values(room.sessions || {})].forEach(repairLineDurations);
        [room, ...Object.values(room.sessions || {})].forEach(cleanImportedCaptions);
        [room, ...Object.values(room.sessions || {})].forEach(normalizeEditorState);
        delete room.audioTracksPending; // track extraction did not survive the restart: start over
      }
      return loaded;
    }
  } catch (err) {
    console.error('[Dubline] Could not read saved rooms:', err.message);
  }
  return {};
}

// Sessions loaded before the fix: lines with MP3/OGG voices and no explicit end were 3 seconds long.
// Recompute the length from the original voice once.
function repairLineDurations(session) {
  let fixed = 0;
  for (const line of (session && session.lines) || []) {
    if (line.durationChecked || !line.originalAudioUrl) continue;
    line.durationChecked = true;
    repairedOnLoad = true;
    if (Math.abs((line.end - line.start) - 3) > 0.001) continue; // the end was given in the pack
    const file = diskPathForUrl(line.originalAudioUrl);
    if (!file || !fs.existsSync(file)) continue;
    const duration = path.extname(file).toLowerCase() === '.wav' ? getWavDuration(fs.readFileSync(file)) : probeAudioDuration(file);
    if (duration && Math.abs(duration - 3) > 0.05) {
      line.end = Number((line.start + duration).toFixed(3));
      fixed++;
    }
  }
  if (fixed) console.log(`[Dubline] Fixed line lengths in "${session.title}": ${fixed}`);
}

// Scenes imported before the ASS parsing fix: drop drawing lines (without takes) and \h, \N tags
function cleanImportedCaptions(session) {
  if (!session || !Array.isArray(session.lines) || session.captionsCleaned) return;
  session.captionsCleaned = true;
  repairedOnLoad = true;
  if (session.kind !== 'custom') return;
  const before = session.lines.length;
  const kept = session.lines.filter(line => line.audioUrl || !isAssDrawing(line.caption || ''));
  kept.forEach(line => { line.caption = cleanAssText(line.caption || ''); });
  if (kept.length !== before) {
    session.lines.splice(0, session.lines.length, ...kept); // same array, so the link to the active session stays intact
    console.log(`[Dubline] Removed subtitle drawing lines from "${session.title}": ${before - kept.length}`);
  }
}

function normalizeEditorState(session) {
  if (!session || !Array.isArray(session.lines)) return;
  session.characterClaims = Object.assign(Object.create(null), session.characterClaims);
  session.projectAudio = projectAudio.normalize(session);
  if (!['edit', 'dub'].includes(session.mode)) {
    session.mode = 'dub';
    repairedOnLoad = true;
  }
  const names = [...new Set(session.lines.map(line => String(line.character || 'Character')).filter(Boolean))];
  if (!Array.isArray(session.trackOrder)) {
    session.trackOrder = names;
    repairedOnLoad = true;
  } else {
    session.trackOrder = [...new Set([...session.trackOrder.map(String).filter(Boolean), ...names])];
  }
  let maxId = 0;
  session.lines.forEach(line => {
    maxId = Math.max(maxId, Number(line.id) || 0);
    if (!Number.isInteger(line.revision) || line.revision < 0) {
      line.revision = 0;
      repairedOnLoad = true;
    }
  });
  // Lines in the trash keep their ids: a new line must not reuse one, or restoring would drop it
  (session.deletedLines || []).forEach(batch => (batch.lines || []).forEach(entry => {
    maxId = Math.max(maxId, Number(entry.line && entry.line.id) || 0);
  }));
  if (!Number.isInteger(session.nextLineId) || session.nextLineId <= maxId) {
    session.nextLineId = maxId + 1;
    repairedOnLoad = true;
  }
}

function writeRoomsNow() {
  try {
    Object.values(rooms).forEach(snapshotActive);
    const tmpFile = ROOMS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(rooms));
    fs.renameSync(tmpFile, ROOMS_FILE);
  } catch (err) {
    console.error('[Dubline] Could not save rooms:', err.message);
  }
}

let saveTimer = null;
function saveRooms() {
  // Continuous room/audio activity must not postpone persistence indefinitely.
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeRoomsNow(); }, 1000);
}

function flushRooms() {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeRoomsNow();
}

process.on('SIGINT', () => {
  flushRooms();
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
    characterClaims: Object.create(null),
    host: null,
    hostClientId: null,
    nickOwners: Object.create(null),
    chat: [],
    latency: Object.create(null), // players' microphone delay correction: nick -> ms
    passwordHash: null,   // room password (scrypt); the password itself is not stored
    passwordSalt: null,
    admitted: [],         // devices that already entered the password (not asked again)
    banned: []            // devices the host kicked
  };
  for (const key in defaults) {
    if (rooms[roomId][key] === undefined) rooms[roomId][key] = defaults[key];
  }
  const room = rooms[roomId];
  for (const field of ['nickOwners', 'latency', 'sessions', 'characterClaims']) {
    if (!room[field] || Object.getPrototypeOf(room[field]) !== null) room[field] = Object.assign(Object.create(null), room[field]);
  }
  if (!Array.isArray(room.blindPlayers)) room.blindPlayers = [];
  if (room.activeSessionId === undefined) room.activeSessionId = null;
  // Rooms from older versions: the current scene becomes the first session
  if (room.loaded && !room.activeSessionId) {
    room.activeSessionId = newSessionId();
    room.kind = room.zipUrl ? 'pack' : 'custom';
    room.createdAt = room.updatedAt = Date.now();
    snapshotActive(room);
  }
  return room;
}

// ==========================================
// SESSIONS: a room has several scenes with their own takes and roles; one is active.
// The active session lives directly in the room fields (all other code works with them),
// and room.sessions[id] points to the same arrays.
// ==========================================

function emptySession() {
  return {
    loaded: false, title: '', kind: null, zipUrl: '', videoUrl: '', backingUrl: '', lines: [], characterClaims: {}, createdAt: null, updatedAt: null,
    mode: 'dub', trackOrder: [], nextLineId: 1, blindMode: false,
    externalOriginalUrl: '', audioMetadata: {}, projectAudio: undefined,
    videoHasAudio: undefined, // unknown until probing succeeds; false only for genuinely silent video
    audioTracks: undefined,   // video audio tracks as separate files (if there are several); undefined = not checked yet
    originalTrack: 0,         // which track plays as "Original" (-1 = none)
    backingTrack: -1,         // which track plays as "Background" (-1 = the pack's own backing track or none)
    baseBackingUrl: undefined, // the pack's own backing track, restored when "none" is picked
    deletedLines: []          // trash of the host's deletions for undo (Ctrl+Z), the last MAX_UNDO_BATCHES
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
  normalizeEditorState(room);
}

// Every import is a new session; earlier ones are kept with their takes
function startNewSession(room, fields) {
  snapshotActive(room);
  const now = Date.now();
  room.activeSessionId = newSessionId();
  Object.assign(room, emptySession(), fields, { loaded: true, createdAt: now, updatedAt: now });
  normalizeEditorState(room);
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

// Whether any other session in any room still uses the scene folder
function isSceneDirUsed(dir) {
  return Object.values(rooms).some(room => [room, ...Object.values(room.sessions || {})]
    .some(session => [session.videoUrl, session.backingUrl, session.externalOriginalUrl, session.baseBackingUrl].some(url => sceneDirOf(url) === dir)));
}

// Lines in a session are always sorted by id (the import creates them that way and the list is never re-sorted),
// so a restored line goes before the first one with a larger id: the order is restored exactly,
// whatever order and whichever deletions lines are restored from
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
  const dirs = new Set([session.videoUrl, session.backingUrl, session.externalOriginalUrl, session.baseBackingUrl].map(sceneDirOf).filter(Boolean));
  dirs.forEach(dir => {
    if (isSceneDirUsed(dir)) return;
    const full = path.join(UPLOAD_DIR, dir);
    if (full.startsWith(UPLOAD_DIR + path.sep)) fs.rm(full, { recursive: true, force: true }, () => {});
  });
  if (/^\/uploads\/pack_source_[a-f0-9]{64}\.zip$/.test(session.zipUrl || '') &&
      !Object.values(rooms).some(room => [room, ...Object.values(room.sessions || {})].some(other => other.zipUrl === session.zipUrl))) {
    fs.rm(diskPathForUrl(session.zipUrl), { force: true }, () => {});
  }
  return takes;
}

// Secrets (players' clientIds) never reach clients
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

// A video whose tracks could not be read is tried again later, not on every room event
const audioTrackFailures = new Map(); // videoUrl -> { count, retryAt }

// If the open session's tracks were not checked yet, check them in the background and tell everyone when done
function ensureAudioTracks(roomId) {
  const room = getRoom(roomId);
  if (!room.loaded || (room.audioTracks !== undefined && typeof room.videoHasAudio === 'boolean') || !sceneDirOf(room.videoUrl) || room.audioTracksPending) return;
  const failure = audioTrackFailures.get(room.videoUrl);
  if (failure && Date.now() < failure.retryAt) return;
  const sessionId = room.activeSessionId;
  const videoUrl = room.videoUrl;
  room.audioTracksPending = true;
  extractAudioTracks(videoUrl).then(tracks => {
    audioTrackFailures.delete(videoUrl);
    const target = room.activeSessionId === sessionId ? room : room.sessions[sessionId];
    if (room.videoUrl === videoUrl) delete room.audioTracksPending;
    if (!target || target.videoUrl !== videoUrl) return;
    target.audioTracks = tracks;
    target.videoHasAudio = tracks.length > 0;
    if (target.originalTrack === undefined) target.originalTrack = 0;
    if (target.backingTrack === undefined) target.backingTrack = -1;
    if (target.baseBackingUrl === undefined) target.baseBackingUrl = target.backingUrl || '';
    snapshotActive(room);
    saveRooms();
    if (target === room) emitSession(roomId);
    if (tracks.length) logEvent(roomId, `🎧 Audio tracks found: ${tracks.length} (${tracks.map(t => t.label || t.language).join(', ')})`);
  }).catch(() => {
    if (room.videoUrl === videoUrl) delete room.audioTracksPending;
    // 15 s, 30 s, 1 min … up to 10 min between attempts
    const count = (audioTrackFailures.get(videoUrl)?.count || 0) + 1;
    audioTrackFailures.set(videoUrl, { count, retryAt: Date.now() + Math.min(10 * 60 * 1000, 15000 * 2 ** (count - 1)) });
  });
}

// A role with no lines left is no longer needed
function dropEmptyRoleClaims(room) {
  for (const character of Object.keys(room.characterClaims)) {
    if (!room.lines.some(l => l.character === character)) delete room.characterClaims[character];
  }
}

// Load saved rooms; save the timing repair right away so it runs only once
Object.assign(rooms, loadRooms());
if (repairedOnLoad) writeRoomsNow();

module.exports = {
  saveRooms,
  flushRooms,
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
  dropEmptyRoleClaims,
  normalizeEditorState
};
