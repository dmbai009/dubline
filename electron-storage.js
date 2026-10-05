const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FOLDERS = ['data', 'uploads', 'packs'];
class StorageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new StorageError(code, message); };
const contains = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

// Preferences stay in userData. Only server-owned directories belong to this storage root.
class DesktopStorage {
  constructor(userData) {
    this.userData = path.resolve(userData);
    this.file = path.join(this.userData, 'storage.json');
    this.config = {};
    this.busy = false;
    try {
      this.config = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (this.config.version !== 1 || typeof this.config.root !== 'string' || !path.isAbsolute(this.config.root) ||
          (this.config.pending && (typeof this.config.pending !== 'string' || !path.isAbsolute(this.config.pending)))) throw new Error('Invalid storage setting');
    } catch (error) {
      if (error.code !== 'ENOENT') this.configError = true;
      this.config = {};
    }
  }
  info() { return { root: this.config.root || this.userData, pending: this.config.pending || '', busy: this.busy, error: this.configError ? 'config' : '' }; }
  async save(config) {
    await fs.promises.mkdir(this.userData, { recursive: true });
    const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({ version: 1, ...config }), { flag: 'wx' });
      await fs.promises.rename(temporary, this.file);
      this.config = { version: 1, ...config };
      this.configError = false;
    } finally { await fs.promises.rm(temporary, { force: true }).catch(() => {}); }
  }
  async root() {
    if (this.configError) fail('config', 'The storage setting is damaged.');
    const root = this.info().root;
    if (this.config.root && !fs.existsSync(root)) fail('missing', 'The storage folder is unavailable. Connect the drive and retry.');
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.access(root, fs.constants.R_OK | fs.constants.W_OK);
    return root;
  }
  async validate(selected) {
    const source = await fs.promises.realpath(await this.root());
    const parent = await fs.promises.realpath(selected);
    const target = path.join(parent, 'Dubline');
    if (target === source) return target;
    if (contains(source, target) || contains(target, source)) fail('overlap', 'Choose a folder outside the current storage folder.');
    // Do not let a junction redirect migration into another project or a user's unrelated files.
    if (fs.existsSync(target)) {
      const stat = await fs.promises.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.promises.readdir(target)).length) fail('occupied', 'The destination Dubline folder must be empty.');
    }
    await fs.promises.access(parent, fs.constants.W_OK);
    return target;
  }
  async choose(selected, defer, progress = () => {}) {
    if (this.busy) fail('busy', 'Storage migration is already running.');
    this.busy = true;
    try {
      const target = await this.validate(selected);
      const current = await fs.promises.realpath(await this.root());
      if (target === current) { await this.save({ root: this.info().root }); return this.info(); }
      await this.save({ root: this.info().root, pending: target });
      if (!defer) await this.migrate(progress);
      return this.info();
    } finally { this.busy = false; }
  }
  async prepare(progress = () => {}) {
    if (this.busy) fail('busy', 'Storage migration is already running.');
    this.busy = true;
    try { await this.migrate(progress); return await this.root(); }
    finally { this.busy = false; }
  }
  async migrate(progress) {
    if (!this.config.pending) return;
    const source = await this.root();
    const target = await this.validate(path.dirname(this.config.pending));
    if (target !== this.config.pending) fail('changed', 'The destination folder changed. Select it again.');
    const files = [];
    async function scan(relative) {
      const absolute = path.join(source, relative);
      let stat;
      try { stat = await fs.promises.lstat(absolute); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (stat.isSymbolicLink()) fail('symlink', 'Storage contains a symbolic link.');
      if (stat.isDirectory()) {
        files.push({ relative, directory: true });
        for (const entry of await fs.promises.readdir(absolute)) await scan(path.join(relative, entry));
      } else if (stat.isFile()) files.push({ relative, size: stat.size });
      else fail('special', 'Storage contains an unsupported file.');
    }
    for (const folder of FOLDERS) await scan(folder);
    const total = files.reduce((bytes, file) => bytes + (file.size || 0), 0);
    const available = await fs.promises.statfs(path.dirname(target));
    if (available.bavail * available.bsize < total + 16 * 1024 * 1024) fail('space', 'Not enough free space in the destination folder.');
    const stage = await fs.promises.mkdtemp(path.join(path.dirname(target), '.dubline-moving-'));
    let published = false, committed = false, completed = 0;
    try {
      progress({ completed, total });
      for (const file of files) {
        const destination = path.join(stage, file.relative);
        if (file.directory) await fs.promises.mkdir(destination, { recursive: true });
        else {
          await fs.promises.copyFile(path.join(source, file.relative), destination, fs.constants.COPYFILE_EXCL);
          if ((await fs.promises.stat(destination)).size !== file.size) fail('copy', 'A storage file could not be copied completely.');
          completed += file.size;
          progress({ completed, total });
        }
      }
      // Recheck after a potentially long copy. Never replace files created in the destination meanwhile.
      await this.validate(path.dirname(target));
      if (fs.existsSync(target)) await fs.promises.rmdir(target);
      await fs.promises.rename(stage, target);
      published = true;
      await this.save({ root: target });
      committed = true;
    } finally {
      if (!committed) await fs.promises.rm(published ? target : stage, { recursive: true, force: true }).catch(() => {});
    }
    // Commit precedes cleanup: interruption can leave an old copy, never an absent project.
    const leftovers = [];
    for (const folder of FOLDERS) {
      const old = path.resolve(source, folder);
      if (path.dirname(old) !== path.resolve(source)) fail('unsafe', 'Unsafe storage cleanup path.');
      try { await fs.promises.rm(old, { recursive: true, force: true }); } catch { leftovers.push(old); }
    }
    if (leftovers.length) progress({ completed, total, leftovers });
  }
}

module.exports = { DesktopStorage, StorageError, FOLDERS };
