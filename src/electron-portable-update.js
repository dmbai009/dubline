const fs = require(process.versions.electron ? 'original-fs' : 'node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const yauzl = require('yauzl');
const { isNewerVersion } = require('./electron-update');
const { MANIFEST_PATH, safeRelative, validateManifest, manifestBytes, bytesHash, verifyTree, safeFile, changesBetween } = require('./electron-managed-files');
const { jsonFrom, download } = require('./electron-update-http');
const RELEASE_API = 'https://api.github.com/repos/dmbai009/dubline/releases/latest';
function validateAsset(value) {
  if (!value || !/^Dubline-[A-Za-z0-9.-]+\.zip$/.test(value.asset) || !Number.isSafeInteger(value.size) ||
      value.size <= 0 || value.size > 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(value.sha256)) throw Error('Invalid Portable asset.');
  return value;
}
function validateMetadata(value, current) {
  if (!value || value.schemaVersion !== 1 || value.channel !== 'github-portable' || value.platform !== current.platform ||
      value.arch !== current.arch || !/^\d+\.\d+\.\d+$/.test(value.version) || !isNewerVersion(value.version, current.version) ||
      !Array.isArray(value.patches) || value.patches.length > 8) throw Error('Invalid Portable update metadata.');
  validateManifest(value.targetManifest); validateAsset(value.full);
  for (const key of ['version', 'channel', 'arch', 'platform', 'commit', 'electronVersion']) {
    if (value[key] !== value.targetManifest[key]) throw Error('Portable target metadata mismatch.');
  }
  if (bytesHash(manifestBytes(value.targetManifest)) !== value.targetManifestHash) throw Error('Portable manifest integrity mismatch.');
  const seen = new Set();
  for (const patch of value.patches) {
    validateAsset(patch);
    if (!/^\d+\.\d+\.\d+$/.test(patch.fromVersion) || !isNewerVersion(value.version, patch.fromVersion) ||
        !/^[a-f0-9]{64}$/.test(patch.requiredBaseManifestHash) || seen.has(patch.fromVersion)) throw Error('Invalid Portable patch base.');
    seen.add(patch.fromVersion);
  }
  return value;
}
async function extractUpdate(archive, folder, target, changed, patch) {
  validateManifest(target);
  const expected = new Map(changed.map(file => [file.path, file]));
  expected.set(MANIFEST_PATH, { size: manifestBytes(target).length });
  if (patch) expected.set('patch.json', { maxSize: 1024 * 1024 });
  const seen = new Set(); let total = 0;
  const zip = await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  try {
    await new Promise((resolve, reject) => {
      zip.once('error', reject); zip.once('end', resolve);
      zip.on('entry', entry => {
        (async () => {
          safeRelative(entry.fileName);
          const key = entry.fileName.toLowerCase(), wanted = expected.get(entry.fileName);
          if (seen.has(key) || !wanted || entry.fileName.endsWith('/') || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 ||
              entry.uncompressedSize > (wanted.maxSize || wanted.size) || wanted.size !== undefined && entry.uncompressedSize !== wanted.size) {
            throw Error('Unexpected or unsafe update ZIP entry.');
          }
          seen.add(key); total += entry.uncompressedSize;
          if (total > 8 * 1024 ** 3) throw Error('Update archive is too large.');
          const file = await safeFile(folder, entry.fileName, true);
          await fsp.mkdir(path.dirname(file), { recursive: true });
          const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
          await pipeline(stream, fs.createWriteStream(file, { flags: 'wx' }));
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  if (seen.size !== expected.size) throw Error('Update archive is incomplete.');
  const manifest = await fsp.readFile(path.join(folder, ...MANIFEST_PATH.split('/')));
  if (bytesHash(manifest) !== bytesHash(manifestBytes(target))) throw Error('Staged manifest mismatch.');
  if (patch) {
    const actual = JSON.parse(await fsp.readFile(path.join(folder, 'patch.json'), 'utf8'));
    if (actual.schemaVersion !== 1 || actual.fromVersion !== patch.fromVersion || actual.toVersion !== patch.toVersion ||
        actual.requiredBaseManifestHash !== patch.requiredBaseManifestHash || actual.targetManifestHash !== patch.targetManifestHash ||
        JSON.stringify(actual.changed) !== JSON.stringify(patch.changed) || JSON.stringify(actual.removed) !== JSON.stringify(patch.removed)) throw Error('Patch contents do not match expected changes.');
  }
  await verifyTree(folder, target, changed);
}
class PortableUpdater extends EventEmitter {
  constructor({ current, root, stagingRoot, helper, busy, shutdown, exit, getProcesses = () => [{ id: process.pid }], json = jsonFrom, fetchFile = download }) {
    super(); Object.assign(this, { current, root: path.resolve(root), stagingRoot, helper, busy, shutdown, exit, getProcesses, json, fetchFile });
    this.status = { state: 'idle', currentVersion: current.version, version: '', url: '', progress: null };
    this.job = null; this.staged = null; this.installing = false;
  }
  set(value) { this.status = { ...this.status, ...value }; this.emit('status', this.getStatus()); }
  getStatus() { return { ...this.status }; }
  async startHelper(job, helper) {
    const ready = path.join(path.dirname(job), 'helper-ready.json');
    await fsp.rm(ready, { force: true });
    // Start-Process creates an independent hidden console. DETACHED_PROCESS
    // prevents Windows PowerShell from running; an inherited console closes
    // its children when Electron exits.
    const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const literal = value => "'" + value.replaceAll("'", "''") + "'";
    const command = `Start-Process -FilePath ${literal(powershell)} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${literal('"' + helper + '"')},'-JobFile',${literal('"' + job + '"')}) -WindowStyle Hidden`;
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', command],
      { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { if (JSON.parse(await fsp.readFile(ready, 'utf8')).ready === true) { this.exit(); return; } } catch { /* helper startup */ }
      if (child.exitCode !== null && child.exitCode !== 0) throw Error('Portable helper launcher failed.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Portable helper did not accept its job.');
  }
  async resumeInterrupted() {
    let lock;
    try { lock = await fsp.open(path.join(this.root, '.dubline-update.lock'), 'r+'); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('Another Portable update is applying. Wait for it to finish before opening Dubline.'); }
    finally { await lock?.close(); }
    const journalName = path.join(this.root, '.dubline-update-journal.json');
    let journal;
    try { journal = JSON.parse(await fsp.readFile(journalName, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return false; throw Error('The interrupted update journal is damaged. Restore the full Portable ZIP manually.'); }
    if (journal.phase === 'committed' || journal.phase === 'rolledBack') {
      if (journal.schemaVersion !== 1 || path.resolve(journal.root) !== this.root) throw Error('Invalid completed update journal.');
      if (typeof journal.jobFile === 'string') {
        const relative = path.relative(path.resolve(this.stagingRoot), path.resolve(journal.jobFile)).replace(/\\/g, '/');
        try {
          const job = await safeFile(this.stagingRoot, relative);
          if (path.basename(job) !== 'job.json' || !path.basename(path.dirname(job)).startsWith('portable-update-')) throw Error('Invalid completed update job.');
          const plan = JSON.parse(await fsp.readFile(job, 'utf8'));
          if (path.resolve(plan.root) !== this.root || plan.baseManifestHash !== journal.baseManifestHash) throw Error('Invalid completed update job.');
          const result = JSON.parse(await fsp.readFile(path.join(path.dirname(job), 'update-result.json'), 'utf8'));
          this.emit('apply-result', { state: result.ok ? 'committed' : 'rolled-back', recovered: result.recovered, helperLine: result.helperLine, version: this.current.version });
          if (!result.ok) this.set({ state:'error', version:plan.target.version, recovered:result.recovered===true,
            error:'The previous update was rolled back. Retry or download the official release manually.' });
          if (journal.phase === 'committed') await fsp.rm(path.dirname(job), { recursive: true, force: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return false;
    }
    if (journal.schemaVersion !== 1 || path.resolve(journal.root) !== this.root || typeof journal.jobFile !== 'string') throw Error('Invalid update recovery journal.');
    const relative = path.relative(path.resolve(this.stagingRoot), path.resolve(journal.jobFile)).replace(/\\/g, '/');
    const job = await safeFile(this.stagingRoot, relative);
    const plan = JSON.parse(await fsp.readFile(job, 'utf8'));
    validateManifest(plan.base); validateManifest(plan.target);
    if (path.resolve(plan.root) !== this.root || plan.baseManifestHash !== journal.baseManifestHash ||
        bytesHash(manifestBytes(plan.base)) !== plan.baseManifestHash || bytesHash(manifestBytes(plan.target)) !== plan.targetManifestHash) throw Error('Invalid interrupted update plan.');
    const helper = path.join(path.dirname(job), 'apply-update.ps1');
    await safeFile(this.stagingRoot, path.relative(this.stagingRoot, helper).replace(/\\/g, '/'), true);
    await fsp.copyFile(this.helper, helper);
    plan.processes = this.getProcesses(); plan.restart = true;
    await fsp.writeFile(job, JSON.stringify(plan, null, 2) + '\n');
    await this.shutdown(); await this.startHelper(job, helper);
    return true;
  }
  async writable() {
    const stat = await fsp.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Portable install root must be a regular writable folder.');
    const file = path.join(this.root, `.dubline-write-test-${require('node:crypto').randomUUID()}`);
    await fsp.writeFile(file, '', { flag: 'wx' }); await fsp.unlink(file);
  }
  async space(folder, required) {
    if (!fsp.statfs) return;
    const capacity = await fsp.statfs(folder);
    if (Number(capacity.bavail) * Number(capacity.bsize) < required + 128 * 1024 ** 2) throw Error('Not enough free space for the Portable update.');
  }
  check() {
    if (this.job) return this.job;
    if (['downloaded', 'installing'].includes(this.status.state)) return Promise.resolve(this.getStatus());
    this.job = this.checkAndStage().catch(() => this.set({ state: 'error', error: 'Update failed. Move Dubline to a writable folder, retry or download the official release manually.', progress: null }))
      .finally(() => { this.job = null; });
    return this.job;
  }
  async checkAndStage() {
    this.set({ state: 'checking', error: '' });
    const release = await this.json(RELEASE_API, 1024 * 1024);
    if (release.draft || release.prerelease || !isNewerVersion(release.tag_name, this.current.version)) { this.set({ state: 'current' }); return; }
    if (!/^v?\d+\.\d+\.\d+$/.test(release.tag_name) || !Array.isArray(release.assets)) throw Error('Invalid stable release.');
    const metadataAsset = release.assets.find(asset => asset.name === 'portable-update.json');
    if (!metadataAsset) throw Error('This release has no Portable update metadata.');
    const assetUrl = name => {
      const asset = release.assets.find(asset => asset.name === name);
      const expected = `https://github.com/dmbai009/dubline/releases/download/${release.tag_name}/${name}`;
      if (!asset || asset.browser_download_url !== expected) throw Error('Update asset is outside the official release.');
      return expected;
    };
    const metadata = validateMetadata(await this.json(assetUrl('portable-update.json')), this.current);
    if (metadata.version !== release.tag_name.replace(/^v/, '')) throw Error('Release and target version mismatch.');
    this.set({ state: 'available', version: metadata.version, url: `https://github.com/dmbai009/dubline/releases/tag/${release.tag_name}` });
    await this.writable();
    const base = validateManifest(JSON.parse(await fsp.readFile(path.join(this.root, ...MANIFEST_PATH.split('/')), 'utf8')));
    if (base.version !== this.current.version || base.commit !== this.current.commit) throw Error('Portable base metadata mismatch.');
    const baseHash = bytesHash(manifestBytes(base));
    let patch = metadata.patches.find(item => item.fromVersion === base.version && item.requiredBaseManifestHash === baseHash);
    if (patch) { try { await verifyTree(this.root, base); } catch (_) { patch = null; } }
    const changes = changesBetween(base, metadata.targetManifest);
    const patchInfo = patch && { schemaVersion: 1, fromVersion: base.version, toVersion: metadata.version,
      requiredBaseManifestHash: baseHash, targetManifestHash: metadata.targetManifestHash,
      removed: changes.removed, changed: changes.changed.map(file => file.path) };
    const stageOne = async selectedPatch => {
      await fsp.mkdir(this.stagingRoot, { recursive: true });
      const folder = await fsp.mkdtemp(path.join(this.stagingRoot, 'portable-update-'));
      const content = path.join(folder, 'files'); await fsp.mkdir(content);
      const asset = selectedPatch ? patch : metadata.full, archive = path.join(folder, 'update.zip');
      this.set({ state: 'downloading', progress: null });
      try {
        const changed = selectedPatch ? changes.changed : metadata.targetManifest.files;
        await this.space(folder, asset.size + changed.reduce((sum, file) => sum + file.size, 0));
        await this.fetchFile(assetUrl(asset.asset), archive, asset, progress => this.set({ progress }));
        await extractUpdate(archive, content, metadata.targetManifest, changed, selectedPatch ? patchInfo : null);
        await fsp.rm(archive, { force: true });
        const plan = { schemaVersion: 1, root: this.root, staged: content, base, target: metadata.targetManifest,
          baseManifestHash: baseHash, targetManifestHash: metadata.targetManifestHash, full: !selectedPatch,
          changed: changed.map(file => file.path), removed: changes.removed, restart: true, processes: [] };
        const job = path.join(folder, 'job.json'); await fsp.writeFile(job, JSON.stringify(plan, null, 2) + '\n');
        const helper = path.join(folder, 'apply-update.ps1'); await fsp.copyFile(this.helper, helper);
        this.staged = { job, helper, folder, plan };
        this.set({ state: 'downloaded', progress: null, downloadKind: selectedPatch ? 'patch' : 'full' });
      } catch (error) {
        if (!path.resolve(folder).startsWith(path.resolve(this.stagingRoot) + path.sep)) throw Error('Unsafe staging cleanup.');
        await fsp.rm(folder, { recursive: true, force: true }); throw error;
      }
    };
    if (patch) { try { await stageOne(true); return; } catch (_) { /* Verified full fallback uses the same managed scope. */ } }
    await stageOne(false);
  }
  async installOrRestart() {
    if (this.installing || this.status.state !== 'downloaded' || !this.staged) return { ok: false, code: 'not-ready' };
    this.installing = true;
    try {
      if (await this.busy()) return { ok: false, code: 'busy' };
      await this.writable();
      if (!this.staged.plan.full) await verifyTree(this.root, this.staged.plan.base);
      const changed = new Set([...this.staged.plan.changed, ...this.staged.plan.removed]);
      const backup = this.staged.plan.base.files.filter(file => changed.has(file.path)).reduce((sum, file) => sum + file.size, 0);
      await this.space(this.root, backup + Math.max(...this.staged.plan.target.files.filter(file => changed.has(file.path)).map(file => file.size), 0));
      this.set({ state: 'installing' });
      const processes = this.getProcesses();
      // Cleanly flush workspace and stop FFmpeg/tunnel/server children before starting the helper.
      await this.shutdown();
      this.staged.plan.processes = processes;
      await fsp.writeFile(this.staged.job, JSON.stringify(this.staged.plan, null, 2) + '\n');
      await this.startHelper(this.staged.job, this.staged.helper); return { ok: true };
    } catch (_) { this.set({ state: 'error', error: 'Could not install update. Download the official Portable ZIP manually.' }); return { ok: false, code: 'install-failed' }; }
    finally { this.installing = false; }
  }
}
module.exports = { validateAsset, validateMetadata, extractUpdate, PortableUpdater };
