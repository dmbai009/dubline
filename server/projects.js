// Portable projects are an explicit data model, never a dump of a runtime room.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const JSZip = require('jszip');
const audio = require('../public/project-audio');
const { emptyTake } = require('./parsers');
const { UPLOAD_DIR, MAX_VIDEO_MB, MAX_CAPTION_LENGTH, VOICE_EFFECTS, MAX_PITCH, MAX_LATENCY_MS, HttpError } = require('./config');
const { diskPathForUrl } = require('./files');

const FORMAT = 'dubline-project';
const VERSION = 2;
// Production save/open uses project-archive.js and bounded streams.
const MAX_VIDEO_BYTES = MAX_VIDEO_MB * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_LINES = 2000;
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.m4a', '.aac', '.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new HttpError(400, message, 'project.invalid'); };
const videoTooLarge = () => { throw new HttpError(413, 'Project video exceeds the video limit', 'error.videoTooBig', { max: MAX_VIDEO_MB }); };
function hashFileSync(file) {
  const digest = crypto.createHash('sha256'), chunk = Buffer.allocUnsafe(256 * 1024);
  const fd = fs.openSync(file, 'r');
  try { let n; while ((n = fs.readSync(fd, chunk, 0, chunk.length, null))) digest.update(chunk.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const text = (value, max, nonempty = false) => typeof value === 'string' && value.length <= max && (!nonempty || value.length > 0);

// Capture metadata AND every referenced file synchronously before the first await. No
// socket edit, take replacement/deletion, or source switch can interleave the snapshot.
function captureProject(session, resolveAsset = diskPathForUrl, snapshotDir = null) {
  if (!session || !session.loaded || !session.videoUrl) throw new HttpError(400, 'No scene video', 'error.noScene');
  if (!Array.isArray(session.lines) || session.lines.length > MAX_LINES) fail('Too many project lines');
  const assets = [];
  const files = new Map();
  const byUrl = new Map();
  let totalBytes = 0;
  function asset(url, recording = false) {
    if (!url) return null;
    if (byUrl.has(url)) return byUrl.get(url);
    let source;
    try { source = resolveAsset(url); } catch { fail('Invalid project media reference'); }
    const ext = source && path.extname(source).toLowerCase();
    if (!source || !MEDIA_EXTENSIONS.has(ext)) fail('Unsupported project media reference');
    let bytes, size;
    const name = `${recording ? 'recordings/take' : 'media/asset'}_${assets.length}${ext}`;
    try {
      size = fs.statSync(source).size;
      if (!size) fail('Empty project media');
      if (url === session.videoUrl && size > MAX_VIDEO_BYTES) videoTooLarge();
      if (snapshotDir) { bytes = path.join(snapshotDir, 'asset_' + assets.length + ext); fs.copyFileSync(source, bytes, fs.constants.COPYFILE_EXCL); }
      else bytes = fs.readFileSync(source);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (['ENOSPC', 'EDQUOT'].includes(error.code)) throw new HttpError(507, 'Not enough disk space', 'project.diskSpace');
      throw new HttpError(404, 'Referenced project media is missing', 'project.missingMedia');
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes)) fail('Invalid combined asset size');
    assets.push({ path: name, size, sha256: snapshotDir ? hashFileSync(bytes) : hash(bytes) });
    files.set(name, bytes);
    byUrl.set(url, name);
    return name;
  }
  function metadata(raw) {
    const result = {};
    for (const channel of ['original', 'backing']) {
      const source = raw && raw[channel];
      if (source) result[channel] = { name: source.name, duration: source.duration, size: source.size };
    }
    return result;
  }
  const mix = audio.normalize(session);
  delete mix.revision;
  const project = {
    title: session.title || '',
    kind: session.kind === 'pack' ? 'pack' : 'custom',
    editorMode: session.mode === 'edit' ? 'edit' : 'dub',
    roles: [...(session.trackOrder || [])],
    roleClaims: Object.fromEntries(Object.entries(session.characterClaims || {})),
    media: {
      video: asset(session.videoUrl),
      original: asset(session.externalOriginalUrl),
      backing: asset(session.backingUrl),
      baseBacking: asset(session.baseBackingUrl),
      originalTrack: session.originalTrack ?? 0,
      backingTrack: session.backingTrack ?? -1,
      audioTracks: (session.audioTracks || []).map(track => ({
        index: track.index, asset: asset(track.url), language: track.language || 'und',
        label: track.label || '', codec: track.codec || ''
      })),
      // null means not probed yet: the existing extraction workflow will recover it.
      videoHasAudio: typeof session.videoHasAudio === 'boolean' ? session.videoHasAudio : null
    },
    audioMetadata: metadata(session.audioMetadata),
    // These values preserve the audible placement of EXISTING takes. They are not
    // microphone device/preferences to apply to the next user's new recordings.
    takeLatency: Object.fromEntries([...new Set(session.lines.filter(line => line.audioUrl && line.recordedBy).map(line => line.recordedBy))]
      .map(author => [author, audio.takeLatency(session, author)])),
    mix,
    lines: session.lines.map(line => ({
      id: line.id, character: line.character, caption: line.caption || '', start: line.start, end: line.end,
      claimedBy: line.claimedBy || null, reference: asset(line.originalAudioUrl),
      take: {
        asset: asset(line.audioUrl, true), audioStart: line.audioStart ?? null,
        recordedStart: line.recordedStart ?? null, trimStart: line.trimStart ?? null, trimEnd: line.trimEnd ?? null,
        trimEnabled: line.trimEnabled !== false, effect: line.effect || 'none', pitch: line.pitch || 0,
        recordedBy: line.recordedBy || null
      }
    }))
  };
  if (session.originalVideoUrl) {
    project.media.originalVideo = asset(session.originalVideoUrl);
    project.media.originalVideoName = String(session.originalVideoName || 'source').slice(0, 200);
  }
  const manifest = { format: FORMAT, formatVersion: session.originalVideoUrl ? VERSION : 1, project, assets };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (manifestBytes.length > MAX_MANIFEST_BYTES) fail('Project manifest is too large');
  validateManifest(manifest);
  return { manifest, files, manifestBytes, totalBytes: totalBytes + manifestBytes.length };
}

// Small-buffer compatibility helpers for fixture/tools callers; production uses project-archive.js.
async function exportProject(session, resolveAsset) {
  const snapshot = captureProject(session, resolveAsset);
  const zip = new JSZip();
  zip.file('project.json', snapshot.manifestBytes);
  for (const [name, bytes] of snapshot.files) zip.file(name, bytes);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  return { buffer, title: snapshot.manifest.project.title, bytes: snapshot.totalBytes };
}

function safeArchivePath(name) {
  // Reject percent encoding too: no importer should have to guess whether to decode it.
  return text(name, 240, true) && !/[\\\x00-\x1f\x7f:%]/.test(name) && !name.startsWith('/') &&
    name.split('/').every(part => part !== '.' && part !== '..' && part.length > 0);
}

function validateManifest(manifest) {
  if (!object(manifest) || manifest.format !== FORMAT) fail('Invalid project manifest');
  if (![1, VERSION].includes(manifest.formatVersion)) throw new HttpError(400, 'Unsupported project version', 'project.unsupportedVersion');
  if (!Array.isArray(manifest.assets) || !manifest.assets.length || manifest.assets.length >= MAX_ENTRIES) fail('Invalid project assets');
  const assets = new Map();
  let totalBytes = 0;
  for (const asset of manifest.assets) {
    if (!object(asset) || !safeArchivePath(asset.path) || !/^(media|recordings)\/[^/]+$/.test(asset.path) ||
        !MEDIA_EXTENSIONS.has(path.posix.extname(asset.path).toLowerCase()) || assets.has(asset.path) ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || !text(asset.sha256, 64) || !/^[a-f0-9]{64}$/.test(asset.sha256)) fail('Invalid project asset metadata');
    totalBytes += asset.size;
    if (!Number.isSafeInteger(totalBytes)) fail('Invalid combined asset size');
    assets.set(asset.path, asset);
  }
  const p = manifest.project;
  if (!object(p) || !text(p.title, 2000) || !['pack', 'custom'].includes(p.kind) || !['edit', 'dub'].includes(p.editorMode)) fail('Invalid project details');
  if (!Array.isArray(p.roles) || p.roles.length > MAX_LINES || p.roles.some(role => !text(role, 500, true)) ||
      new Set(p.roles).size !== p.roles.length || !object(p.roleClaims)) fail('Invalid project roles');
  if (Object.entries(p.roleClaims).some(([role, owner]) => !p.roles.includes(role) || !text(owner, 16, true))) fail('Invalid role ownership');
  if (!object(p.takeLatency) || Object.keys(p.takeLatency).length > MAX_LINES ||
      Object.entries(p.takeLatency).some(([author, ms]) => !text(author, 16, true) || !finite(ms, -MAX_LATENCY_MS, MAX_LATENCY_MS))) fail('Invalid take latency');
  const referenced = new Set();
  function ref(value, required = false, video = false) {
    if (value === null && !required) return;
    if (typeof value !== 'string' || !assets.has(value)) fail('Missing project media reference');
    if (video && !['.mp4', '.webm'].includes(path.posix.extname(value).toLowerCase())) fail('Invalid video reference');
    referenced.add(value);
  }
  const m = p.media;
  if (!object(m) || ![null, true, false].includes(m.videoHasAudio) || !Array.isArray(m.audioTracks) || m.audioTracks.length > 64 ||
      !Number.isInteger(m.originalTrack) || m.originalTrack < -1 || !Number.isInteger(m.backingTrack) || m.backingTrack < -1) fail('Invalid source selection');
  if (manifest.formatVersion === 2) {
    ref(m.originalVideo, true);
    if (!['.mp4', '.mkv', '.webm'].includes(path.posix.extname(m.originalVideo).toLowerCase()) ||
        m.originalVideo === m.video || !text(m.originalVideoName, 200, true)) fail('Invalid original video');
  } else if (m.originalVideo !== undefined || m.originalVideoName !== undefined) fail('Original video requires project version 2');
  ref(m.video, true, true);
  if (assets.get(m.video).size > MAX_VIDEO_BYTES) videoTooLarge();
  ref(m.original); ref(m.backing); ref(m.baseBacking);
  m.audioTracks.forEach((track, index) => {
    if (!object(track) || track.index !== index || !text(track.language, 40) || !text(track.label, 500) || !text(track.codec, 80)) fail('Invalid embedded audio track');
    ref(track.asset, true);
  });
  if ((m.audioTracks.length && m.originalTrack >= m.audioTracks.length) ||
      (!m.audioTracks.length && m.originalTrack > 0) || m.backingTrack >= m.audioTracks.length) fail('Invalid selected track');
  if (!object(p.audioMetadata)) fail('Invalid source metadata');
  for (const channel of ['original', 'backing']) {
    const meta = p.audioMetadata[channel];
    if (meta !== undefined && (!object(meta) || !text(meta.name, 200) || !finite(meta.duration, 0, 86400) ||
        !Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > Number.MAX_SAFE_INTEGER)) fail('Invalid audio metadata');
  }
  const mix = p.mix;
  if (!object(mix) || typeof mix.autoDuckEnabled !== 'boolean' || !finite(mix.autoDuckAmount, 0, 0.8)) fail('Invalid project mix');
  for (const channel of audio.CHANNELS) {
    const c = mix[channel];
    if (!object(c) || !finite(c.volume, 0, audio.MAX_VOLUME) || typeof c.muted !== 'boolean' || typeof c.solo !== 'boolean' ||
        (channel !== 'dub' && !finite(c.offset, -43200, 43200))) fail('Invalid project channel');
  }
  if (!Array.isArray(p.lines) || p.lines.length > MAX_LINES) fail('Invalid project lines');
  const ids = new Set();
  for (const line of p.lines) {
    if (!object(line) || !Number.isSafeInteger(line.id) || line.id < 1 || line.id >= Number.MAX_SAFE_INTEGER || ids.has(line.id) ||
        !p.roles.includes(line.character) || !text(line.caption, MAX_CAPTION_LENGTH) ||
        !finite(line.start, 0, 86400) || !finite(line.end, 0, 86400) || line.start >= line.end ||
        !(line.claimedBy === null || text(line.claimedBy, 16, true))) fail('Invalid project line');
    ids.add(line.id); ref(line.reference);
    const take = line.take;
    if (!object(take) || !VOICE_EFFECTS.includes(take.effect) || !finite(take.pitch, -MAX_PITCH, MAX_PITCH) ||
        typeof take.trimEnabled !== 'boolean' || !(take.recordedBy === null || text(take.recordedBy, 16, true))) fail('Invalid project take');
    for (const field of ['audioStart', 'recordedStart', 'trimStart', 'trimEnd']) {
      if (take[field] !== null && !finite(take[field], field.startsWith('trim') ? 0 : -86400, 86400)) fail('Invalid take alignment');
    }
    if ((take.trimStart === null) !== (take.trimEnd === null) ||
        (take.trimStart !== null && take.trimStart >= take.trimEnd)) fail('Invalid take trim');
    ref(take.asset);
  }
  if (referenced.size !== assets.size) fail('Unreferenced project asset');
  return manifest;
}

// Validate archive headers and schema before decompression/extraction. CRC, exact size,
// and SHA-256 are checked as each declared asset is read. Filenames are never extracted.
function readProject(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('Empty project archive');
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    if (!entries.length || entries.length > MAX_ENTRIES) fail('Invalid project entry count');
    const filesByName = new Map();
    let total = 0;
    for (const entry of entries) {
      const name = entry.entryName;
      if (!safeArchivePath(entry.isDirectory ? name.slice(0, -1) : name) || filesByName.has(name)) fail('Unsafe or duplicate project archive path');
      // Symlinks and other Unix special files are not project assets.
      const mode = (entry.header.attr >>> 16) & 0xf000;
      if (mode && mode !== 0x8000 && mode !== 0x4000) fail('Unsupported project archive entry');
      total += entry.header.size;
      if (!Number.isSafeInteger(total)) fail('Invalid combined asset size');
      if (entry.isDirectory && entry.header.size) fail('Invalid archive directory');
      filesByName.set(name, entry);
    }
    const manifestEntry = filesByName.get('project.json');
    if (!manifestEntry || manifestEntry.isDirectory || manifestEntry.header.size > MAX_MANIFEST_BYTES) fail('Missing or oversized project manifest');
    const bytes = manifestEntry.getData();
    if (bytes.length !== manifestEntry.header.size || bytes.length > MAX_MANIFEST_BYTES) fail('Damaged project manifest');
    const manifest = validateManifest(JSON.parse(bytes.toString('utf8')));
    const declared = new Set(['project.json', ...manifest.assets.map(asset => asset.path)]);
    if (entries.some(entry => !entry.isDirectory && !declared.has(entry.entryName))) fail('Unexpected project archive file');
    const files = new Map();
    for (const asset of manifest.assets) {
      const entry = filesByName.get(asset.path);
      if (!entry || entry.isDirectory || entry.header.size !== asset.size) fail('Missing or inconsistent project asset');
      const data = entry.getData();
      if (data.length !== asset.size || hash(data) !== asset.sha256) fail('Damaged project asset');
      files.set(asset.path, data);
    }
    return { manifest, files };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail('Damaged project archive');
  }
}

function fieldsForProject(project, urls) {
  const url = asset => asset ? urls.get(asset) : '';
  const m = project.media;
  const mix = audio.normalize({ projectAudio: project.mix });
  const audioMetadata = {};
  for (const channel of ['original', 'backing']) {
    const meta = project.audioMetadata[channel];
    if (meta) audioMetadata[channel] = { name: meta.name, duration: meta.duration, size: meta.size };
  }
  return {
    title: project.title, kind: project.kind, mode: project.editorMode, zipUrl: '',
    trackOrder: [...project.roles], characterClaims: Object.assign(Object.create(null), project.roleClaims),
    takeLatency: Object.assign(Object.create(null), project.takeLatency),
    videoUrl: url(m.video), originalVideoUrl: url(m.originalVideo), originalVideoName: m.originalVideoName || '', externalOriginalUrl: url(m.original), backingUrl: url(m.backing), baseBackingUrl: url(m.baseBacking),
    originalTrack: m.originalTrack, backingTrack: m.backingTrack,
    audioTracks: m.videoHasAudio === null && !m.audioTracks.length ? undefined : m.audioTracks.map(track => ({
      index: track.index, url: url(track.asset), language: track.language, label: track.label, codec: track.codec
    })),
    videoHasAudio: m.videoHasAudio === null ? undefined : m.videoHasAudio,
    audioMetadata, projectAudio: mix,
    lines: project.lines.map(line => ({
      id: line.id, character: line.character, caption: line.caption, start: line.start, end: line.end,
      claimedBy: line.claimedBy, originalAudioUrl: url(line.reference) || null,
      durationChecked: true, revision: 0, ...emptyTake(),
      audioUrl: url(line.take.asset) || null,
      audioStart: line.take.audioStart, recordedStart: line.take.recordedStart,
      trimStart: line.take.trimStart, trimEnd: line.take.trimEnd, trimEnabled: line.take.trimEnabled,
      effect: line.take.effect, pitch: line.take.pitch, recordedBy: line.take.recordedBy
      // Fresh session/sequence identity: old queued uploads must never target these takes.
    }))
  };
}

// Caller owns commit: inspect/probe staged media, recheck host/session, then publish.
// Rollback deletes only the freshly generated paths, never the previous scene.
function stageProject(buffer, uploadDir = UPLOAD_DIR) {
  return stageProjectFiles(readProject(buffer), uploadDir);
}
function stageProjectFiles({ manifest, files }, uploadDir = UPLOAD_DIR, onDisk = false) {
  const stageDir = fs.mkdtempSync(path.join(uploadDir, '.project-'));
  const id = crypto.randomUUID().replace(/-/g, '');
  const sceneName = `custom_project_${id}`;
  const finalDir = path.join(uploadDir, sceneName);
  const urls = new Map();
  const takeMoves = [];
  const publishedTakes = [];
  const mediaFiles = [];
  let published = false;
  function rollback() {
    for (const file of publishedTakes) fs.rmSync(file, { force: true });
    if (published) fs.rmSync(finalDir, { recursive: true, force: true });
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
  try {
    let index = 0;
    for (const [asset, data] of files) {
      const ext = path.posix.extname(asset).toLowerCase();
      const recording = asset.startsWith('recordings/');
      const filename = recording ? `line_project_${id}_${index++}${ext}` : `${asset === manifest.project.media.originalVideo ? 'source_video' : 'asset'}_${index++}${ext}`;
      const staged = path.join(stageDir, filename);
      if (onDisk) fs.renameSync(data, staged);
      else fs.writeFileSync(staged, data, { flag: 'wx' });
      mediaFiles.push({ path: staged, primary: asset === manifest.project.media.video, video: asset === manifest.project.media.video || asset === manifest.project.media.originalVideo });
      if (recording) {
        takeMoves.push({ filename, staged, final: path.join(uploadDir, filename) });
        urls.set(asset, `/uploads/${filename}`);
      } else urls.set(asset, `/uploads/${sceneName}/${filename}`);
    }
    const fields = fieldsForProject(manifest.project, urls);
    return {
      fields, mediaFiles, stageDir,
      commit() {
        try {
          for (const move of takeMoves) {
            fs.renameSync(move.staged, move.final);
            publishedTakes.push(move.final);
          }
          fs.renameSync(stageDir, finalDir);
          published = true;
          return fields;
        } catch (error) { rollback(); throw error; }
      },
      rollback
    };
  } catch (error) { rollback(); throw error; }
}

module.exports = { FORMAT, VERSION, MAX_VIDEO_MB, MAX_MANIFEST_BYTES, MAX_ENTRIES, safeArchivePath, captureProject, hashFileSync, exportProject, validateManifest, readProject, stageProject, stageProjectFiles };
