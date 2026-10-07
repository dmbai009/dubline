// Build the core once; Setup and Portable consume that exact ASAR/runtime.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yazl = require('yazl');
const { MANIFEST_PATH, createManifest, manifestBytes, bytesHash, fileHash, changesBetween, verifyTree } = require('../electron-managed-files');
const root = path.resolve(__dirname, '..');
const qaVersion = process.env.DUBLINE_QA_VERSION;
if (qaVersion && !/^\d+\.\d+\.\d+$/.test(qaVersion)) throw new Error('Invalid QA build version.');
const output = qaVersion ? path.join(root, 'build', 'update-qa', qaVersion) : path.join(root, 'dist');
const unpacked = path.join(output, 'win-unpacked');
function command(file, args) {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed (${result.status}).`);
}
function builder(args) { command(process.execPath, [require.resolve('electron-builder/cli'), ...args, '--config.directories.output=' + output,
  ...(qaVersion ? ['--config.extraMetadata.version=' + qaVersion] : []), '--publish', 'never']); }
function distribution(channel) {
  const metadata = require('../package.json');
  const commit = spawnSync('git', ['-c', `safe.directory=${root.replace(/\\/g, '/')}`, 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (commit.status !== 0 || !/^[a-f0-9]{40}$/.test(commit.stdout.trim())) throw new Error('A Git commit is required for distribution metadata.');
  const version = qaVersion || metadata.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Only stable versions can be built by this release pipeline.');
  return { schemaVersion: 1, channel, version, commit: commit.stdout.trim(),
    electronVersion: require('electron/package.json').version, platform: 'win32', arch: 'x64' };
}
async function writeMarker(directory, channel) {
  await fsp.writeFile(path.join(directory, 'resources', 'dubline-distribution.json'), JSON.stringify(distribution(channel), null, 2) + '\n');
}
async function zipFiles(directory, files, destination, extra = {}) {
  const zip = new yazl.ZipFile();
  for (const file of files) zip.addFile(path.join(directory, ...file.split('/')), file);
  for (const [name, bytes] of Object.entries(extra)) zip.addBuffer(Buffer.from(bytes), name);
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(destination, { flags: 'wx' });
    stream.once('error', reject); stream.once('close', resolve); zip.outputStream.once('error', reject);
    zip.outputStream.pipe(stream); zip.end();
  });
}
async function freshOutput(file) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(output + path.sep)) throw new Error('Artifact is outside dist.');
  await fsp.rm(resolved, { force: true });
}
async function buildUnpacked() {
  command(process.execPath, ['tools/build-icons.js']);
  command(process.execPath, ['tools/download-cloudflared.js']);
  builder(['--win', '--x64', '--dir']);
  await writeMarker(unpacked, 'github-setup');
}
async function buildSetup() {
  await writeMarker(unpacked, 'github-setup');
  // --prepackaged does not run the normal packaging hook that creates this file.
  await fsp.writeFile(path.join(unpacked, 'resources', 'app-update.yml'), 'provider: github\nowner: dmbai009\nrepo: dubline\nupdaterCacheDirName: dubline-updater\n');
  builder(['--win', 'nsis', '--x64', '--prepackaged', unpacked]);
}
async function buildPortable(baseFolder) {
  const folder = path.join(output, 'portable');
  // This folder contains generated app files only, never a user's installation.
  if (path.resolve(folder) !== path.join(output, 'portable') || !output.startsWith(root + path.sep)) throw new Error('Unsafe build folder.');
  await fsp.rm(folder, { force: true, recursive: true });
  await fsp.cp(unpacked, folder, { recursive: true, dereference: false });
  await writeMarker(folder, 'github-portable');
  const marker = distribution('github-portable');
  const manifest = await createManifest(folder, marker), bytes = manifestBytes(manifest);
  await fsp.writeFile(path.join(folder, ...MANIFEST_PATH.split('/')), bytes);
  const name = `Dubline-${marker.version}-win-x64-Portable.zip`, file = path.join(output, name);
  await freshOutput(file); await zipFiles(folder, [...manifest.files.map(entry => entry.path), MANIFEST_PATH], file);
  const metadata = { ...marker, targetManifest: manifest, targetManifestHash: bytesHash(bytes),
    full: { asset: name, size: (await fsp.stat(file)).size, sha256: await fileHash(file) }, patches: [] };
  if (baseFolder) {
    const base = JSON.parse(await fsp.readFile(path.join(baseFolder, ...MANIFEST_PATH.split('/')), 'utf8'));
    await verifyTree(baseFolder, base);
    const { isNewerVersion } = require('../electron-update');
    if (!isNewerVersion(marker.version, base.version)) throw new Error('Patch target must be newer than its base.');
    const changes = changesBetween(base, manifest);
    const patchName = `Dubline-${base.version}-to-${marker.version}-win-x64-Patch.zip`, patchFile = path.join(output, patchName);
    const patch = { schemaVersion: 1, fromVersion: base.version, toVersion: marker.version,
      requiredBaseManifestHash: bytesHash(manifestBytes(base)), targetManifestHash: metadata.targetManifestHash,
      removed: changes.removed, changed: changes.changed.map(entry => entry.path) };
    await freshOutput(patchFile);
    await zipFiles(folder, changes.changed.map(entry => entry.path), patchFile, {
      [MANIFEST_PATH]: bytes, 'patch.json': JSON.stringify(patch, null, 2) + '\n' });
    metadata.patches.push({ fromVersion: base.version, requiredBaseManifestHash: patch.requiredBaseManifestHash,
      asset: patchName, size: (await fsp.stat(patchFile)).size, sha256: await fileHash(patchFile) });
  }
  await fsp.writeFile(path.join(output, 'portable-update.json'), JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}
async function inventory() {
  const artifacts = [];
  const version = distribution('github-setup').version;
  const setup = `Dubline-${version}-win-x64-Setup.exe`;
  const names = new Set([setup, setup + '.blockmap', 'latest.yml', 'portable-update.json']);
  try {
    const portable = JSON.parse(await fsp.readFile(path.join(output, 'portable-update.json'), 'utf8'));
    if (portable.version === version) for (const asset of [portable.full, ...portable.patches]) names.add(asset.asset);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of [...names].sort()) {
    const file = path.join(output, name), stat = await fsp.stat(file);
    if (stat.isFile()) artifacts.push({ asset: name, size: stat.size, sha256: await fileHash(file) });
  }
  await fsp.writeFile(path.join(output, 'release-artifacts.json'), JSON.stringify({ ...distribution('github-setup'), artifacts }, null, 2) + '\n');
}
async function main() {
  const mode = process.argv[2] || 'all';
  if (!['unpacked', 'setup', 'portable', 'all'].includes(mode)) throw new Error('Unknown distribution build mode.');
  if (process.platform !== 'win32') throw new Error('Build Windows distributions on Windows.');
  if (mode === 'unpacked' || mode === 'all') await buildUnpacked();
  if (mode === 'setup' || mode === 'all') await buildSetup();
  const patchBase = process.argv[3] || process.env.DUBLINE_PATCH_BASE;
  if (mode === 'portable' || mode === 'all') await buildPortable(patchBase ? path.resolve(patchBase) : null);
  if (mode === 'all') await inventory();
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { zipFiles, buildPortable, distribution };
