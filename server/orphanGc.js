const fs = require('node:fs'), path = require('node:path');
const DAY = 24 * 60 * 60 * 1000;
const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
function references(rooms, uploadRoot, packsRoot) {
  const kept = new Set(), seen = new WeakSet();
  const inspect = value => {
    if (typeof value === 'string') {
      const match = /^\/(uploads|packs)\/([^?#]+)$/.exec(value); if (!match) return;
      try {
        const base = path.resolve(match[1] === 'uploads' ? uploadRoot : packsRoot), target = path.resolve(base, decodeURIComponent(match[2]));
        const relative = path.relative(base, target); if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
        kept.add(identity(path.resolve(base, relative.split(path.sep)[0])));
      } catch { /* malformed historical URL cannot designate a cleanup target */ }
    } else if (value && typeof value === 'object' && !seen.has(value)) { seen.add(value); Object.values(value).forEach(inspect); }
  };
  inspect(rooms); return kept;
}
function recognized(area, entry) {
  if (entry.isSymbolicLink()) return false;
  if (entry.isDirectory()) {
    if (/^\.(incoming|pack-export|project-export|project-reading|project|pack)-[A-Za-z0-9]{6}$/.test(entry.name)) return true;
    return area === 'uploads' && /^(pack_[a-f0-9]{64}|custom_project_[a-f0-9]{32}|custom_\d{13}_[a-z0-9]{6})$/.test(entry.name);
  }
  return entry.isFile() && (area === 'uploads' && /^(line_.+_\d+_[a-f0-9-]{36}|line_project_[a-f0-9]{32}_\d+)\.webm$/.test(entry.name) || area === 'packs' && /^pack_source_[a-f0-9]{64}\.zip$/.test(entry.name));
}
async function collect({ roots, rooms, idle = () => true, grace = 7 * DAY, now = Date.now() }) {
  if (!idle()) return [];
  // Use the same canonical roots for references and deletion candidates. Windows
  // TEMP can contain 8.3 aliases, and selected storage can have a junction parent.
  const canonicalRoots = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([area, root]) => [area, await fs.promises.realpath(root)])));
  const liveReferences = () => references(rooms, canonicalRoots.uploads, canonicalRoots.packs);
  const kept = liveReferences(), removed = [];
  for (const [area, base] of Object.entries(canonicalRoots)) {
    if (!idle()) break;
    for (const entry of await fs.promises.readdir(base, { withFileTypes: true })) {
      if (!idle()) return removed;
      if (!recognized(area, entry)) continue;
      const target = path.resolve(base, entry.name), relative = path.relative(base, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || kept.has(identity(target))) continue;
      const stat = await fs.promises.lstat(target);
      if (stat.isSymbolicLink() || Math.max(stat.mtimeMs, stat.ctimeMs) + grace > now || !idle()) continue;
      // Recheck live references immediately before removal, after asynchronous IO.
      if (liveReferences().has(identity(target))) continue;
      // Never follow a reparse point inside an owned-looking directory.
      const safe = async directory => {
        for (const child of await fs.promises.readdir(directory, { withFileTypes: true })) {
          if (child.isSymbolicLink() || child.isDirectory() && !await safe(path.join(directory, child.name))) return false;
        }
        return true;
      };
      if (stat.isDirectory() && !await safe(target) || !idle() || liveReferences().has(identity(target))) continue;
      await fs.promises.rm(target, { recursive: stat.isDirectory(), force: false }); removed.push(target);
    }
  }
  return removed;
}
function start() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    const { rooms, recordingNow } = require('./state'), { DATA_DIR, UPLOAD_DIR, PACKS_DIR } = require('./config');
    const idle = () => !require('./app').isHttpBusy() && !require('./routes').isMediaBusy() && !require('./project-save').isBusy() && !Object.values(recordingNow).some(recordings => Object.keys(recordings).length);
    if (!idle()) return;
    running = true;
    try { await collect({ roots: { data: DATA_DIR, uploads: UPLOAD_DIR, packs: PACKS_DIR }, rooms, idle }); }
    catch (error) { console.info('[DubLine] Orphan cleanup skipped:', error.message); }
    finally { running = false; }
  }, 60 * 60 * 1000); timer.unref(); return timer;
}
module.exports = { references, recognized, collect, start };
