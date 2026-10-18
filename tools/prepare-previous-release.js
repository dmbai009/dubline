// One direct patch from the previous compatible manifest-based Portable release.
// Legacy self-extracting releases are an explicit full-download migration.
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path');
const { jsonFrom, download } = require('../src/electron-update-http');
const { validateMetadata, extractUpdate } = require('../src/electron-portable-update');
const { verifyTree } = require('../src/electron-managed-files');
const { isNewerVersion } = require('../src/electron-update');
const { isAppVersion, isBeta } = require('../src/update-version');
const root = path.resolve(__dirname, '..');
async function releaseList({ env = process.env, execute = require('node:child_process').execFile, json = jsonFrom } = {}) {
  // Hosted runners share anonymous API limits. Keep CI authentication in gh's
  // environment, never in asset URLs or the application's update HTTP client.
  if (env.GITHUB_ACTIONS !== 'true' || !env.GH_TOKEN) return json('https://api.github.com/repos/dmbai009/dubline/releases?per_page=100', 4 * 1024 ** 2);
  const text = await new Promise((resolve, reject) => execute('gh', ['api', 'repos/dmbai009/dubline/releases?per_page=100'],
    { env, encoding: 'utf8', maxBuffer: 4 * 1024 ** 2, timeout: 60000, windowsHide: true },
    (error, stdout) => error ? reject(Error('Authenticated previous-release lookup failed.')) : resolve(stdout)));
  return JSON.parse(text);
}
async function prepare() {
  const version = require('../package.json').version;
  const releases = await releaseList();
  if (!Array.isArray(releases)) throw Error('Invalid official release list.');
  const older = releases.filter(release => !release.draft && (isBeta(version) || !release.prerelease && !isBeta(release.tag_name)) && isAppVersion(String(release.tag_name).replace(/^v/, '')) && isNewerVersion(version, release.tag_name.slice(1)))
    .sort((a,b) => isNewerVersion(a.tag_name.slice(1),b.tag_name.slice(1)) ? -1 : 1);
  const previous = older[0];
  const info = previous?.assets?.find(asset => asset.name === 'portable-update.json');
  if (!info) { console.log('Previous stable has no managed Portable manifest; this release uses the full-download migration.'); return null; }
  const metadata = validateMetadata(await jsonFrom(info.browser_download_url, 8 * 1024 ** 2), { channel:'github-portable', platform:'win32', arch:'x64', version:'0.0.0' });
  if (metadata.version !== previous.tag_name.slice(1)) throw Error('Previous release tag does not match its manifest.');
  const asset = previous.assets.find(asset => asset.name === metadata.full.asset);
  if (!asset) throw Error('Previous stable Portable ZIP is missing.');
  await fsp.mkdir(path.join(root,'build'),{recursive:true});
  const folder = await fsp.mkdtemp(path.join(root,'build','previous-release-'));
  const archive = path.join(folder,'previous.zip'), portable = path.join(folder,'portable');
  await fsp.mkdir(portable);
  await download(asset.browser_download_url,archive,metadata.full,()=>{});
  await extractUpdate(archive,portable,metadata.targetManifest,metadata.targetManifest.files,null);
  await verifyTree(portable,metadata.targetManifest);
  await fsp.unlink(archive);
  if (process.env.GITHUB_ENV) await fsp.appendFile(process.env.GITHUB_ENV,`DUBLINE_PATCH_BASE=${portable}\n`);
  console.log(`Verified previous stable ${metadata.version}; direct patch base: ${portable}`);
  return portable;
}
if(require.main===module)prepare().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={prepare,releaseList};
