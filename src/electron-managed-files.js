// Shared build/update validation. These manifests describe application files only.
// Application payloads are real files, including app.asar. Electron's patched
// fs interprets ASAR paths as virtual archives, even before extraction creates them.
const fs = require(process.versions.electron ? 'original-fs' : 'node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const MANIFEST_PATH = 'resources/dubline-managed.json';
const ROOT_FILES = new Set(['Dubline.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
  'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll',
  'libGLESv2.dll', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources.pak',
  'snapshot_blob.bin', 'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json',
  'vulkan-1.dll', 'notification_helper.exe']);
function safeRelative(value) {
  if (typeof value !== 'string' || value.length > 1024 || !value || value.includes('\\') ||
      value.startsWith('/') || value.includes(':') || /[\x00-\x1f]/.test(value)) throw new Error('Unsafe managed path.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe managed path.');
  return value;
}
function managedPath(value) {
  safeRelative(value);
  if (value === MANIFEST_PATH || /\.dubline$/i.test(value) ||
      !(ROOT_FILES.has(value) || value.startsWith('resources/') || value.startsWith('locales/'))) {
    throw new Error(`Outside application managed scope: ${value}`);
  }
  return value;
}
function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || value.channel !== 'github-portable' || value.platform !== 'win32' ||
      value.arch !== 'x64' || !/^\d+\.\d+\.\d+$/.test(value.version) ||
      !/^[a-f0-9]{40}$/.test(value.commit) || !/^\d+\.\d+\.\d+$/.test(value.electronVersion) ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > 8192) throw new Error('Invalid managed manifest.');
  const seen = new Set(); let total = 0;
  for (const file of value.files) {
    managedPath(file.path);
    const key = file.path.toLowerCase();
    if (seen.has(key) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 2 * 1024 ** 3 ||
        !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid managed file entry.');
    seen.add(key); total += file.size;
  }
  if (total > 8 * 1024 ** 3 || !seen.has('dubline.exe') || !seen.has('resources/app.asar') ||
      !seen.has('resources/dubline-distribution.json')) throw new Error('Incomplete or oversized managed manifest.');
  return value;
}
function manifestBytes(value) { return Buffer.from(JSON.stringify(validateManifest(value), null, 2) + '\n'); }
function bytesHash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function safeFile(root, relative, allowMissing = false) {
  safeRelative(relative);
  const absoluteRoot = path.resolve(root);
  const rootStat = await fsp.lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Install root is not a regular directory.');
  let current = absoluteRoot;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if ((await fsp.lstat(current)).isSymbolicLink()) throw new Error('Managed path contains a link.'); }
    catch (err) { if (!(allowMissing && err.code === 'ENOENT')) throw err; }
  }
  const resolved = path.resolve(absoluteRoot, ...relative.split('/'));
  if (!path.relative(absoluteRoot, resolved) || path.relative(absoluteRoot, resolved).startsWith('..')) throw new Error('Unsafe resolved path.');
  return resolved;
}
async function verifyTree(root, manifest, subset = manifest.files) {
  validateManifest(manifest);
  for (const file of subset) {
    const name = await safeFile(root, file.path);
    const stat = await fsp.lstat(name);
    if (!stat.isFile() || stat.size !== file.size || await fileHash(name) !== file.sha256) {
      throw new Error(`Managed file integrity mismatch: ${file.path}`);
    }
  }
}
async function createManifest(root, distribution) {
  const files = [];
  async function walk(directory, prefix = '') {
    for (const entry of (await fsp.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix + entry.name;
      if (relative === MANIFEST_PATH) continue;
      if (entry.isSymbolicLink()) throw new Error('Build tree contains a link.');
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + '/');
      else if (entry.isFile()) {
        managedPath(relative);
        const name = path.join(directory, entry.name), stat = await fsp.stat(name);
        files.push({ path: relative, size: stat.size, sha256: await fileHash(name) });
      } else throw new Error('Build tree contains a non-regular file.');
    }
  }
  await walk(root);
  return validateManifest({ ...distribution, files });
}
function changesBetween(base, target) {
  validateManifest(base); validateManifest(target);
  if (base.arch !== target.arch || base.channel !== target.channel || base.platform !== target.platform) throw new Error('Incompatible patch target.');
  const previous = new Map(base.files.map(file => [file.path, file]));
  const oldNames = new Map(base.files.map(file => [file.path.toLowerCase(), file.path]));
  for (const file of target.files) {
    if (oldNames.has(file.path.toLowerCase()) && oldNames.get(file.path.toLowerCase()) !== file.path) throw new Error('Case-only managed path changes are unsupported on Windows.');
  }
  const next = new Set(target.files.map(file => file.path));
  return { changed: target.files.filter(file => previous.get(file.path)?.sha256 !== file.sha256 || previous.get(file.path)?.size !== file.size),
    removed: base.files.filter(file => !next.has(file.path)).map(file => file.path) };
}
module.exports = { MANIFEST_PATH, safeRelative, managedPath, validateManifest, manifestBytes, bytesHash, fileHash,
  safeFile, verifyTree, createManifest, changesBetween };
