// Files on disk: paths behind /uploads and /packs, sizes and hashes, take deletion
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UPLOAD_DIR, PACKS_DIR } = require('./config');

// Owned scene/source folder inside uploads, including separately prepared backgrounds.
function sceneDirOf(url) {
  const match = /^\/uploads\/([^/]+)\//.exec(decodeURIComponent(url || ''));
  return match && /^(pack_|custom_|backing_[a-f0-9-]+$)/.test(match[1]) ? match[1] : null;
}

// Media file sizes are shown on the download buttons. They are cached so the disk is not hit
// on every session broadcast; unknown sizes (the file is still being written) are not cached.
const fileSizeCache = new Map();
const fileHashCache = new Map();

function diskPathForUrl(url) {
  const rel = decodeURIComponent(url).replace(/^\/+/, '');
  const [top, ...rest] = rel.split('/');
  const base = top === 'uploads' ? UPLOAD_DIR : top === 'packs' ? PACKS_DIR : null;
  if (!base) return null;
  const full = path.join(base, ...rest);
  return full.startsWith(base + path.sep) ? full : null;
}

function fileSizeForUrl(url) {
  if (!url) return null;
  if (fileSizeCache.has(url)) return fileSizeCache.get(url);
  try {
    const full = diskPathForUrl(url);
    if (!full) return null;
    const size = fs.statSync(full).size;
    fileSizeCache.set(url, size);
    return size;
  } catch (err) {
    return null;
  }
}

// SHA-256 of a media file: players use it to verify video received from other players over P2P
function fileHashForUrl(url) {
  if (!url) return null;
  if (fileHashCache.has(url)) return fileHashCache.get(url);
  try {
    const full = diskPathForUrl(url);
    if (!full) return null;
    const digest = crypto.createHash('sha256'), chunk = Buffer.allocUnsafe(256 * 1024);
    const fd = fs.openSync(full, 'r');
    try { let n; while ((n = fs.readSync(fd, chunk, 0, chunk.length, null))) digest.update(chunk.subarray(0, n)); }
    finally { fs.closeSync(fd); }
    const hash = digest.digest('hex');
    fileHashCache.set(url, hash);
    return hash;
  } catch (err) {
    return null;
  }
}

function forgetFileSizes(...urls) {
  urls.forEach(url => {
    if (!url) return;
    fileSizeCache.delete(url);
    fileHashCache.delete(url);
  });
}

const takePins = new Map(), deferredTakes = new Map(), deferredSceneDirs = new Set();
let persistedReferences = null;
const identity = file => process.platform === 'win32' ? file.toLowerCase() : file;
function takePath(url) {
  try {
    const decoded = decodeURIComponent(url || '');
    const match = /^\/uploads\/(line_[^/\\?#:\x00-\x1f]+\.(?:webm|wav|ogg|oga|opus|mp3|m4a|aac|flac|mp4|mkv))$/i.exec(decoded);
    if (!match) return null;
    const root = fs.realpathSync(UPLOAD_DIR), file = path.resolve(root, match[1]);
    return file.startsWith(root + path.sep) ? file : null;
  } catch { return null; }
}
function takeUrls(line) { return [...new Set([line?.audioUrl, ...(Array.isArray(line?.takeHistory) ? line.takeHistory : []).map(take => take?.audioUrl)].filter(url => typeof url === 'string' && url))]; }
function scenePath(dir) {
  if (typeof dir !== 'string' || !/^[A-Za-z0-9_-]+$/.test(dir) || sceneDirOf('/uploads/' + dir + '/asset') !== dir) return null;
  const root = fs.realpathSync(UPLOAD_DIR), target = path.resolve(root, dir);
  return target.startsWith(root + path.sep) ? target : null;
}
function deleteSceneFiles(dir) {
  try {
    const target = scenePath(dir); if (!target) return;
    const key = identity(target);
    if (references(require('./state').rooms).has(key)) { deferredSceneDirs.delete(dir); return; }
    if (!persistedReferences || persistedReferences.has(key) || takePins.has(key)) { deferredSceneDirs.add(dir); return; }
    const stat = fs.lstatSync(target); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    fs.rmSync(target, { recursive: true }); deferredSceneDirs.delete(dir);
  } catch (error) { if (error.code === 'ENOENT') deferredSceneDirs.delete(dir); else console.error('[DubLine] Scene cleanup postponed:', error.code || 'IO'); }
}
function references(value) { return require('./orphanGc').references(value, fs.realpathSync(UPLOAD_DIR), fs.realpathSync(PACKS_DIR)); }
function notePersistedReferences(value) {
  try {
    persistedReferences = references(value);
    for (const [url, options] of [...deferredTakes]) { deferredTakes.delete(url); deleteTakeFile(url, options); }
    for (const dir of [...deferredSceneDirs]) deleteSceneFiles(dir);
  } catch { persistedReferences = null; console.error('[DubLine] Take cleanup paused: references are unavailable.'); }
}
function deleteTakeFile(url, options = {}) {
  const file = takePath(url); if (!file) return { kept: true };
  const key = identity(file);
  try { if (references(require('./state').rooms).has(key)) return { kept: true }; }
  catch { deferredTakes.set(url, options); return { deferred: true, error: 'references' }; }
  if (!persistedReferences || persistedReferences.has(key) || takePins.has(key)) {
    deferredTakes.set(url, options); return { deferred: true };
  }
  try {
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) return { kept: true };
    fs.unlinkSync(file); forgetFileSizes(url); return { deleted: true };
  } catch (error) {
    if (error.code === 'ENOENT') return { deleted: true };
    console.error('[DubLine] Take cleanup postponed:', error.code || 'IO');
    try { options.onError?.(error); } catch { /* Cleanup notifications cannot roll back a persisted scene. */ }
    return { error: error.code || 'IO' };
  }
}
function retainTakeFiles(urls) {
  const keys = [...new Set(urls.map(url => takePath(url) || scenePath(sceneDirOf(url))).filter(Boolean).map(identity))];
  for (const key of keys) takePins.set(key, (takePins.get(key) || 0) + 1);
  let released = false;
  return () => {
    if (released) return; released = true;
    for (const key of keys) { const remaining = takePins.get(key) - 1; remaining ? takePins.set(key, remaining) : takePins.delete(key); }
    for (const [url, options] of [...deferredTakes]) { deferredTakes.delete(url); deleteTakeFile(url, options); }
    for (const dir of [...deferredSceneDirs]) deleteSceneFiles(dir);
  };
}

module.exports = {
  sceneDirOf,
  diskPathForUrl,
  fileSizeForUrl,
  fileHashForUrl,
  forgetFileSizes,
  deleteTakeFile, takePath, takeUrls, notePersistedReferences, retainTakeFiles, deleteSceneFiles
};
