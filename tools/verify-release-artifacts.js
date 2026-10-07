const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { verifyTree, fileHash, bytesHash, manifestBytes } = require('../electron-managed-files');
const { validateMetadata } = require('../electron-portable-update');
async function hash(file, algorithm) { const digest = crypto.createHash(algorithm); for await (const bytes of fs.createReadStream(file)) digest.update(bytes); return digest.digest('base64'); }
async function verify(folder) {
  folder = path.resolve(folder);
  const inventory = JSON.parse(await fsp.readFile(path.join(folder, 'release-artifacts.json'), 'utf8'));
  const metadata = JSON.parse(await fsp.readFile(path.join(folder, 'portable-update.json'), 'utf8'));
  const marker = JSON.parse(await fsp.readFile(path.join(folder, 'win-unpacked', 'resources', 'dubline-distribution.json'), 'utf8'));
  assert.equal(inventory.channel, 'github-setup'); assert.equal(metadata.channel, 'github-portable');
  for (const key of ['version', 'commit', 'electronVersion', 'arch', 'platform']) { assert.equal(marker[key], inventory[key]); assert.equal(metadata[key], inventory[key]); }
  if (process.env.DUBLINE_RELEASE_SHA || process.env.GITHUB_SHA) assert.equal(inventory.commit, process.env.DUBLINE_RELEASE_SHA || process.env.GITHUB_SHA);
  validateMetadata(metadata, { ...metadata, version: '0.0.0' });
  assert.equal(bytesHash(manifestBytes(metadata.targetManifest)), metadata.targetManifestHash);
  await verifyTree(path.join(folder, 'portable'), metadata.targetManifest);
  assert.equal(await fileHash(path.join(folder, 'portable', 'resources', 'app.asar')), await fileHash(path.join(folder, 'win-unpacked', 'resources', 'app.asar')));
  const names = new Set(), checksums = [];
  for (const artifact of inventory.artifacts) {
    assert.match(artifact.asset, /^[A-Za-z0-9.-]+$/); assert.ok(!names.has(artifact.asset)); names.add(artifact.asset);
    const file = path.join(folder, artifact.asset); assert.equal((await fsp.stat(file)).size, artifact.size); assert.equal(await fileHash(file), artifact.sha256);
    checksums.push(`${artifact.sha256}  ${artifact.asset}`);
  }
  const latest = yaml.load(await fsp.readFile(path.join(folder, 'latest.yml'), 'utf8'));
  const setup = `Dubline-${inventory.version}-win-x64-Setup.exe`;
  assert.equal(latest.version, inventory.version); assert.equal(latest.path, setup); assert.equal(latest.files.length, 1); assert.equal(latest.files[0].url, setup);
  assert.equal(latest.sha512, await hash(path.join(folder, setup), 'sha512')); assert.equal(latest.files[0].sha512, latest.sha512); assert.equal(latest.files[0].size, (await fsp.stat(path.join(folder, setup))).size);
  const blockmap = JSON.parse(zlib.gunzipSync(await fsp.readFile(path.join(folder, setup + '.blockmap')))); assert.ok(blockmap.files.length > 0);
  for (const asset of [metadata.full, ...metadata.patches]) { assert.ok(names.has(asset.asset)); assert.equal(await fileHash(path.join(folder, asset.asset)), asset.sha256); assert.equal((await fsp.stat(path.join(folder, asset.asset))).size, asset.size); }
  checksums.push(`${await fileHash(path.join(folder, 'release-artifacts.json'))}  release-artifacts.json`);
  await fsp.writeFile(path.join(folder, 'SHA256SUMS.txt'), checksums.sort().join('\n') + '\n');
  console.log(`Verified ${inventory.version} (${inventory.commit}): ${names.size} exact artifacts, Setup SHA-512/blockmap, Portable hashes and shared ASAR; SHA256SUMS.txt generated.`);
}
if (require.main === module) verify(process.argv[2] || 'dist').catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verify };
