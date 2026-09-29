// Files on disk: paths behind /uploads and /packs, sizes and hashes, take deletion
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UPLOAD_DIR, PACKS_DIR } = require('./config');

// The scene folder inside uploads (pack_… or custom_…) if the url points into one
function sceneDirOf(url) {
  const match = /^\/uploads\/([^/]+)\//.exec(decodeURIComponent(url || ''));
  return match && /^(pack_|custom_)/.test(match[1]) ? match[1] : null;
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
    const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
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

function deleteTakeFile(url) {
  if (!url || !url.startsWith('/uploads/line_')) return;
  const file = path.join(UPLOAD_DIR, path.basename(decodeURIComponent(url)));
  fs.rm(file, { force: true }, () => {});
}

module.exports = {
  sceneDirOf,
  diskPathForUrl,
  fileSizeForUrl,
  fileHashForUrl,
  forgetFileSizes,
  deleteTakeFile
};
