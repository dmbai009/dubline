// Файлы на диске: пути по адресам /uploads и /packs, размеры и хеши, удаление дублей
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UPLOAD_DIR, PACKS_DIR } = require('./config');

// Папка сцены внутри uploads (pack_… или custom_…), если url указывает на нее
function sceneDirOf(url) {
  const match = /^\/uploads\/([^/]+)\//.exec(decodeURIComponent(url || ''));
  return match && /^(pack_|custom_)/.test(match[1]) ? match[1] : null;
}

// Размеры медиафайлов показываем на кнопках скачивания. Кэшируем, чтобы не дергать диск
// на каждую рассылку сессии; неизвестные размеры (файл еще пишется) не кэшируем.
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

// SHA-256 медиафайла: игроки проверяют им видео, полученное от других игроков по P2P
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
