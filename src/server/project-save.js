const fs = require('node:fs'), path = require('node:path');
const { exportProjectDisk, stageProjectDisk } = require('./project-archive');
const destinations = new Set();
async function saveProjectFile(snapshot, destination, { signal, beforeCommit, resolveAsset, onProgress = () => {} } = {}) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || path.extname(destination).toLowerCase() !== '.dubline') throw new Error('Invalid project destination.');
  const target = path.resolve(destination), parent = path.dirname(target), key = process.platform === 'win32' ? target.toLowerCase() : target;
  if (destinations.has(key)) throw new Error('This project is already being saved.');
  destinations.add(key);
  let archive, checked;
  try {
    const previous = await fs.promises.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('The destination must be a regular project file.');
    // Build and verify on the destination volume. Cross-volume media are copied
    // by the existing archive builder before the atomic same-directory rename.
    onProgress({stage:'preparing',bytes:0});
    archive = await exportProjectDisk(snapshot, resolveAsset, { folder: parent, signal, onProgress });
    onProgress({stage:'finalizing',bytes:archive.bytes});
    checked = await stageProjectDisk(archive.path, path.dirname(archive.path), { signal });
    checked.rollback(); checked = null;
    signal?.throwIfAborted(); await beforeCommit?.(archive.path);
    signal?.throwIfAborted();
    const current = await fs.promises.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!!previous !== !!current || previous && (previous.ino !== current.ino || previous.mtimeMs !== current.mtimeMs || previous.size !== current.size)) throw new Error('The destination changed while saving. Choose it again.');
    const handle = await fs.promises.open(archive.path, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    signal?.throwIfAborted();
    onProgress({stage:'committing',bytes:archive.bytes});
    await fs.promises.rename(archive.path, target);
    return { bytes: archive.bytes, filename: path.basename(target) };
  } finally { checked?.rollback(); await archive?.cleanup(); destinations.delete(key); }
}
module.exports = { saveProjectFile, isBusy: () => destinations.size > 0 };
