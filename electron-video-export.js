// Renderer capabilities authorize one user-selected destination, never arbitrary paths.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const MAX_CHUNK = 1024 * 1024, MAX_FILE = 64 * 1024 ** 3;
const formats = new Set(['mp4', 'webm', 'mkv']);
function createVideoExportFiles({ choose, freeSpace = async directory => {
  const stat = await fs.promises.statfs(directory); return Number(stat.bavail) * Number(stat.bsize);
}, remember = () => {}, lastDirectory = () => '', confirmOverwrite = async () => false, allowedDestination = async () => true, ttlMs = 4 * 60 * 60 * 1000 }) {
  const jobs = new Map(), choosing = new Set();
  const errorKey = error => ['ENOSPC', 'EDQUOT'].includes(error.code) ? 'project.diskSpace' : 'exportVideo.fileError';
  function get(owner, data) {
    const job = jobs.get(data?.ticket);
    if (!job || job.owner !== owner || job.cancelled || job.expires < Date.now()) throw Error('exportVideo.destinationExpired');
    return job;
  }
  async function cancel(owner, data) {
    const job = jobs.get(data?.ticket); if (!job || job.owner !== owner) return { ok: false };
    if (job.committing) return { ok: false, key: 'exportVideo.committing' };
    clearTimeout(job.timer);
    job.cancelled = true;
    await job.pending.catch(() => {});
    if (job.committed) return { ok: true };
    jobs.delete(data.ticket);
    await job.file?.close().catch(() => {});
    if (job.temp) await fs.promises.unlink(job.temp).catch(() => {});
    return { ok: true, canceled: true };
  }
  async function chooseDestination(owner, data) {
    if (!formats.has(data?.extension) || typeof data.sessionId !== 'string' || data.sessionId.length > 160) return { ok: false, key: 'exportVideo.unsupported' };
    if (Number(data.estimatedBytes) > MAX_FILE) return { ok: false, key: 'exportVideo.fileError' };
    if (choosing.has(owner) || [...jobs.values()].some(job => job.owner === owner && !job.committed) || jobs.size >= 4) return { ok: false, key: 'project.busy' };
    choosing.add(owner);
    try {
      const name = require('./public/video-export-policy').filename(data.title, data.extension);
      const selection = await choose(owner, { defaultPath: path.join(lastDirectory() || '', name), filters: [{ name: data.extension.toUpperCase(), extensions: [data.extension] }], properties: ['showOverwriteConfirmation', 'createDirectory'] });
      if (selection.canceled || !selection.filePath) return { ok: true, canceled: true };
      let destination = selection.filePath;
      if (path.extname(destination).toLowerCase() !== '.' + data.extension) destination += '.' + data.extension;
      if (!await allowedDestination(destination)) throw Error('exportVideo.fileError');
      const stat = await fs.promises.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error('exportVideo.fileError');
      if (stat && destination !== selection.filePath && !await confirmOverwrite(owner, destination)) return { ok: true, canceled: true };
      const estimated = Number(data.estimatedBytes);
      if (estimated > 0 && estimated <= MAX_FILE && await freeSpace(path.dirname(destination)) < estimated + 16 * 1024 ** 2) return { ok: false, key: 'project.diskSpace' };
      const ticket = crypto.randomUUID();
      const job = { owner, destination, sessionId: data.sessionId, original: stat && { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino }, pending: Promise.resolve(), bytes: 0, ranges: [], expires: Date.now() + ttlMs };
      job.timer = setTimeout(() => { void cancel(owner, { ticket }); }, ttlMs); job.timer.unref(); jobs.set(ticket, job);
      remember(path.dirname(destination));
      return { ok: true, ticket, name: path.basename(destination), directory: path.dirname(destination) };
    } catch (error) { return { ok: false, key: error.message.startsWith('exportVideo.') ? error.message : errorKey(error) }; }
    finally { choosing.delete(owner); }
  }
  async function write(owner, data) {
    let job, ownsWrite = false;
    try {
      job = get(owner, data);
      if (job.committed || job.committing || data.sessionId !== job.sessionId || !Number.isSafeInteger(data.position) || data.position < 0 || !(data.bytes instanceof Uint8Array) || data.bytes.byteLength > MAX_CHUNK || data.bytes.byteLength === 0 || data.position + data.bytes.byteLength > MAX_FILE) throw Error('exportVideo.fileError');
      // Reject concurrent calls rather than creating an unbounded IPC write queue.
      if (job.writing) throw Error('project.busy'); job.writing = true; ownsWrite = true;
      job.pending = (async () => {
        if (!job.file) { job.temp = path.join(path.dirname(job.destination), '.' + path.basename(job.destination) + '.' + crypto.randomUUID() + '.part'); job.file = await fs.promises.open(job.temp, 'wx'); }
        let offset = 0;
        while (offset < data.bytes.byteLength) {
          if (job.cancelled) throw Error('exportVideo.cancelled');
          const result = await job.file.write(data.bytes, offset, data.bytes.byteLength - offset, data.position + offset);
          if (!result.bytesWritten) throw Error('exportVideo.fileError'); offset += result.bytesWritten;
        }
        job.bytes = Math.max(job.bytes, data.position + data.bytes.byteLength);
        const merged = [];
        for (const range of [...job.ranges, [data.position, data.position + data.bytes.byteLength]].sort((a, b) => a[0] - b[0])) {
          const previous = merged.at(-1);
          if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]); else merged.push(range);
        }
        if (merged.length > 1024) throw Error('exportVideo.fileError');
        job.ranges = merged;
      })();
      await job.pending;
      return { ok: true, bytes: job.bytes };
    } catch (error) { return { ok: false, key: error.message.startsWith('exportVideo.') || error.message === 'project.busy' ? error.message : errorKey(error) }; }
    finally { if (ownsWrite) job.writing = false; }
  }
  async function reset(owner, data) {
    let job, ownsReset = false;
    try {
      job = get(owner, data);
      if (data.sessionId !== job.sessionId || job.committed || job.committing || job.writing) throw Error('exportVideo.fileError');
      job.writing = true; ownsReset = true;
      job.pending = (async () => {
        if (job.file) await job.file.truncate(0);
        job.bytes = 0; job.ranges = [];
      })();
      await job.pending; return { ok: true, bytes: 0 };
    } catch (error) { return { ok: false, key: error.message.startsWith('exportVideo.') ? error.message : errorKey(error) }; }
    finally { if (ownsReset) job.writing = false; }
  }
  async function commit(owner, data) {
    let job, ownsCommit = false;
    try {
      job = get(owner, data);
      if (data.sessionId !== job.sessionId || data.bytes !== job.bytes) throw Error('exportVideo.fileError');
      if (job.committed) return { ok: true, alreadySaved: true, bytes: job.bytes, name: path.basename(job.destination) };
      if (!job.file || job.writing || job.committing || data.sessionId !== job.sessionId || data.bytes !== job.bytes || !job.bytes || job.ranges.length !== 1 || job.ranges[0][0] !== 0) throw Error('exportVideo.fileError');
      job.committing = true; ownsCommit = true;
      clearTimeout(job.timer);
      job.pending = (async () => {
      await job.file.sync(); await job.file.close(); job.file = null;
      if (job.cancelled) throw Error('exportVideo.cancelled');
      const current = await fs.promises.lstat(job.destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (!!current !== !!job.original || current && (current.isSymbolicLink() || current.size !== job.original.size || current.mtimeMs !== job.original.mtimeMs || current.ino !== job.original.ino)) throw Error('exportVideo.destinationChanged');
      // Same-directory rename replaces an approved file atomically, retaining it on failure.
      await fs.promises.rename(job.temp, job.destination); job.temp = null; job.committed = true; job.expires = Date.now() + ttlMs;
      })();
      await job.pending;
      for (const [ticket, other] of jobs) if (other !== job && other.owner === owner && other.committed) jobs.delete(ticket);
      return { ok: true, bytes: job.bytes, name: path.basename(job.destination) };
    } catch (error) { if (ownsCommit && !job.committed) { job.committing = false; await cancel(owner, data); } return { ok: false, key: error.message.startsWith('exportVideo.') ? error.message : errorKey(error) }; }
    finally { if (ownsCommit) job.committing = false; }
  }
  function revealed(owner, data) { const job = get(owner, data); if (!job.committed) throw Error('exportVideo.fileError'); return job.destination; }
  async function releaseOwner(owner) { await Promise.all([...jobs].filter(([, job]) => job.owner === owner).map(async ([ticket, job]) => { if (job.committing) await job.pending.catch(() => {}); await cancel(owner, { ticket }); jobs.delete(ticket); })); }
  return { chooseDestination, write, reset, commit, cancel, revealed, releaseOwner, get busy() { return choosing.size > 0 || [...jobs.values()].some(job => !job.committed); }, close: () => Promise.all([...new Set([...jobs.values()].map(job => job.owner))].map(releaseOwner)) };
}
module.exports = { createVideoExportFiles, MAX_CHUNK, MAX_FILE };
