// Exact artifact A→B test. Only the network origin and OS relaunch delivery are
// controlled by this test; packaged main/preload/updater/helper code is unchanged.
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const { spawn } = require('node:child_process');
const { launch, wait } = require('./packaged-test-driver');
const { fileHash, verifyTree, MANIFEST_PATH, changesBetween } = require('../electron-managed-files');
const root = path.resolve(__dirname, '..');
const aVersion = require('../package.json').version, bParts = aVersion.split('.').map(Number); bParts[2]++;
const bVersion = bParts.join('.');
const aRoot = path.join(root, 'dist', 'portable'), bOutput = path.join(root, 'build', 'update-qa', bVersion);
async function until(fn, timeout = 45000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { last = await fn(); if (last) return last; } catch (_) {} await wait(100); }
  throw Error('Artifact update smoke timed out: ' + JSON.stringify(last));
}
async function browserFor(running) {
  await until(async () => (await fetch(`http://127.0.0.1:${running.browserPort}/json/version`)).ok);
  return puppeteer.connect({ browserURL: `http://127.0.0.1:${running.browserPort}` });
}
async function workspace(browser) {
  const launcher = await until(async () => (await browser.pages()).find(page => page.url().endsWith('electron-launcher.html')));
  const started = await launcher.evaluate(() => window.dublineLauncher.startSingle());
  assert.equal(started.ok, true, JSON.stringify(started));
  const page = await until(async () => (await browser.pages()).find(page => page.url().startsWith('http://127.0.0.1:')));
  await until(() => page.evaluate(() => socket.connected && amHost())).catch(async error => {
    console.error('Packaged workspace state', await page.evaluate(() => ({ url: location.href, ready: document.readyState, session: typeof session === 'undefined' ? 'missing' : session, connection: typeof socket === 'undefined' ? 'missing' : socket.connected, name: typeof myName === 'undefined' ? 'missing' : myName, errors: document.body.innerText.slice(-1000) })));
    throw error;
  });
  await page.evaluate(() => { if (!myName) { modalNickInput.value = 'Artifact Host'; handleNickSubmit({ preventDefault() {} }); } });
  await until(() => page.evaluate(() => !!myName && amHost() && !!clientId && !!session && !editorNeedsResync));
  return page;
}
async function importFixture(page) {
  const { fixtureVideoPath } = require('../e2e/helpers');
  await page.evaluate(() => { openFilesModal(); switchFilesTab('import'); });
  await (await page.$('#customVideoInput')).uploadFile(fixtureVideoPath());
  await page.evaluate(() => uploadCustomScene());
  await until(() => page.evaluate(() => session?.loaded && video.readyState >= 3));
  await page.evaluate(() => closeFilesModal());
}
async function stop(running, browser) {
  try { await running?.inspector.evaluate("require('electron').app.quit()"); } catch (_) {}
  running?.inspector.close(); browser?.disconnect();
  if (running) await until(() => running.child.exitCode !== null, 10000).catch(() => { running.child.kill(); });
}
async function main() {
  const metadata = JSON.parse(await fsp.readFile(path.join(bOutput, 'portable-update.json'), 'utf8'));
  const base = JSON.parse(await fsp.readFile(path.join(aRoot, ...MANIFEST_PATH.split('/')), 'utf8'));
  assert.equal(metadata.version, bVersion); assert.equal(base.version, aVersion);
  await verifyTree(aRoot, base);
  const changes = changesBetween(base, metadata.targetManifest);
  for (const file of metadata.targetManifest.files) if (/ffmpeg\.exe|cloudflared\.exe|\.dll$/.test(file.path) && base.files.find(previous => previous.path === file.path)?.sha256 === file.sha256) {
    assert.equal(changes.changed.some(changed => changed.path === file.path), false, `unchanged binary ${file.path}`);
  }
  const assets = [metadata.full, ...metadata.patches], release = { tag_name: 'v' + bVersion, draft: false, prerelease: false,
    assets: ['portable-update.json', ...assets.map(asset => asset.asset)].map(name => ({ name, browser_download_url: `https://github.com/dmbai009/dubline/releases/download/v${bVersion}/${name}` })) };
  let downloaded = 0; const requests = [];
  const fixture = http.createServer((request, response) => {
    const name = path.posix.basename(new URL(request.url, 'http://fixture').pathname);
    if (request.url.startsWith('/api.github.com/repos/dmbai009/dubline/releases/latest')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(release)); return; }
    if (name === 'portable-update.json') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(metadata)); return; }
    const asset = assets.find(asset => asset.asset === name);
    if (!asset) { response.writeHead(404); response.end(); return; }
    requests.push(name); response.setHeader('Content-Length', asset.size);
    const stream = fs.createReadStream(path.join(bOutput, name)); stream.on('data', chunk => { downloaded += chunk.length; }); stream.pipe(response);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const testRoot = await fsp.mkdtemp(path.join(root, 'build', 'update-qa', 'artifact-run-'));
  let running, browser, locker;
  try {
    for (const kind of ['patch', 'full', 'rollback']) {
      const install = path.join(testRoot, kind), profile = path.join(testRoot, kind + '-profile');
      await fsp.cp(aRoot, install, { recursive: true });
      await fsp.writeFile(path.join(install, 'Keep мой проект.dubline'), 'untouched-project');
      await fsp.writeFile(path.join(install, 'user-note.txt'), 'untouched-note');
      if (kind === 'full') await fsp.appendFile(path.join(install, 'resources', 'bin', 'cloudflared.exe'), 'local-modification');
      const startBytes = downloaded, startRequests = requests.length;
      const transport = `const https = require('node:https'), http = require('node:http'), original = https.get; https.get = function(value, options, callback) { const url = new URL(value); if (url.hostname === 'api.github.com' || url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com')) return http.get(${JSON.stringify(origin)} + '/' + url.hostname + url.pathname + url.search, options, callback); return original.apply(this, arguments); };`;
      const helperConsole = path.join(testRoot, kind + '-helper-console.log');
      const helperTrace = `const cp=require('node:child_process'), originalSpawn=cp.spawn; cp.spawn=function(command,args,options){if(require('node:path').basename(command).toLowerCase()==='powershell.exe'){const fd=require('node:fs').openSync(${JSON.stringify(helperConsole)},'a');const child=originalSpawn(command,args,{...options,stdio:['ignore',fd,fd]});require('node:fs').writeSync(fd,'Helper PID: '+child.pid+'\\n');require('node:fs').closeSync(fd);return child;}return originalSpawn.apply(this,arguments);};`;
      running = await launch(path.join(install, 'Dubline.exe'), profile, transport + helperTrace);
      browser = await browserFor(running); const page = await workspace(browser);
      const beforeBuild = await page.evaluate(() => window.dublineDesktop.getBuildInfo());
      assert.equal(beforeBuild.version, aVersion); assert.equal(beforeBuild.channel, 'github-portable');
      assert.equal(beforeBuild.commit, base.commit); assert.equal(beforeBuild.electronVersion, require('electron/package.json').version);
      await importFixture(page);
      const identity = await page.evaluate(() => ({ clientId, scene: session.activeSessionId, count: session.sessionList.length }));
      await running.inspector.evaluate('globalThis.__dublineTestUpdater().check()');
      const status = await page.evaluate(() => window.dublineDesktop.getUpdateStatus());
      if (status.state === 'error') await running.inspector.evaluate('globalThis.__dublineTestUpdater().checkAndStage()');
      assert.equal(status.state, 'downloaded', JSON.stringify(status)); assert.equal(status.downloadKind, kind === 'full' ? 'full' : 'patch');
      await page.evaluate(() => { recordState = 'preparing'; });
      assert.equal((await page.evaluate(() => window.dublineDesktop.openUpdate())).code, 'busy');
      await page.evaluate(() => { recordState = 'idle'; });
      await until(async () => await running.inspector.evaluate('globalThis.__dublineTestUpdater().busy().then(busy => !busy)'));
      // Avoid an unsupervised GUI relaunch. The test launches the target explicitly
      // below with the same profile; the native apply and shutdown remain real.
      await running.inspector.evaluate('globalThis.__dublineTestUpdater().staged.plan.restart = false');
      if (kind === 'rollback') {
        const ready = path.join(testRoot, 'lock-ready'), release = path.join(testRoot, 'lock-release');
        const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        locker = spawn(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'qa-file-lock.ps1'),'-File',path.join(install,'resources','dubline-distribution.json'),'-Ready',ready,'-Release',release], { windowsHide:true,stdio:'ignore' });
        await until(() => fsp.stat(ready).then(() => true));
      }
      const closed = new Promise(resolve => running.child.once('exit', resolve));
      void page.evaluate(() => window.dublineDesktop.openUpdate()).catch(() => {});
      await wait(150); running.inspector.close(); browser.disconnect(); browser = null;
      await Promise.race([closed, wait(25000).then(() => { throw Error('Old packaged app did not exit.'); })]); running = null;
      const outcome = await until(async () => {
        const staging = path.join(profile, 'update-staging');
        for (const folder of await fsp.readdir(staging)) {
          try { return JSON.parse(await fsp.readFile(path.join(staging, folder, 'update-result.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return false;
      }, 180000).catch(async error => { console.error(await fsp.readFile(helperConsole, 'utf8').catch(() => 'No helper console output.')); console.error('Native helper diagnostic folder:', testRoot); throw error; });
      const availableLock=await fsp.open(path.join(install,'.dubline-update.lock'),'r+');await availableLock.close();
      if (kind === 'rollback') {
        assert.equal(outcome.ok, false); assert.equal(outcome.recovered, true, JSON.stringify(outcome));
        await fsp.writeFile(path.join(testRoot,'lock-release'),'release');
        await until(() => locker.exitCode !== null); locker = null;
        await verifyTree(install, base);
      } else {
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        await verifyTree(install, metadata.targetManifest);
        assert.equal(await fileHash(path.join(install, 'resources', 'app.asar')), await fileHash(path.join(bOutput, 'win-unpacked', 'resources', 'app.asar')), 'one core ASAR for Setup and Portable');
      }
      assert.equal(await fsp.readFile(path.join(install, 'Keep мой проект.dubline'), 'utf8'), 'untouched-project');
      assert.equal(await fsp.readFile(path.join(install, 'user-note.txt'), 'utf8'), 'untouched-note');
      const expected = kind === 'full' ? metadata.full : metadata.patches[0];
      assert.deepEqual(requests.slice(startRequests), [expected.asset]); assert.equal(downloaded - startBytes, expected.size);
      running = await launch(path.join(install, 'Dubline.exe'), profile); browser = await browserFor(running);
      const reopened = await workspace(browser);
      const afterBuild = await reopened.evaluate(() => window.dublineDesktop.getBuildInfo());
      assert.equal(afterBuild.version, kind === 'rollback' ? aVersion : bVersion);
      assert.equal(afterBuild.channel, 'github-portable');
      assert.equal(afterBuild.commit, metadata.targetManifest.commit);
      assert.equal(afterBuild.electronVersion, beforeBuild.electronVersion);
      if (kind === 'rollback') {
        const recovery = await reopened.evaluate(() => window.dublineDesktop.getUpdateStatus());
        assert.equal(recovery.state, 'error'); assert.equal(recovery.recovered, true, JSON.stringify(recovery));
        const updateLog = JSON.parse(await fsp.readFile(path.join(profile, 'application-update-log.json'), 'utf8'));
        assert.ok(updateLog.events.some(event => event.state === 'rolled-back' && event.recovered === true), 'rollback outcome is visible and logged after restart');
      }
      const after = await reopened.evaluate(() => ({ clientId, count: session.sessionList.length, scenes:session.sessionList.map(scene=>scene.id) }));
      assert.equal(after.clientId, identity.clientId); assert.ok(after.count >= identity.count, 'old workspace scene remains in history');
      assert.ok(after.scenes.includes(identity.scene),'original imported scene remains accessible after restart');
      assert.equal(await running.inspector.evaluate("require('electron').app.getVersion()"), kind === 'rollback' ? aVersion : bVersion);
      await stop(running, browser); running = browser = null;
      console.log(`Exact Portable ${kind} A→B passed; ${expected.size} bytes; profile identity, old scenes and unknown project files preserved.`);
    }
    console.log(`Portable patch saves ${(100 * (1 - metadata.patches[0].size / metadata.full.size)).toFixed(1)}% against the full ZIP.`);
  } catch (error) {
    console.error(running?.log());
    console.error('Portable diagnostic folder:', testRoot);
    throw error;
  } finally {
    if (locker) { await fsp.writeFile(path.join(testRoot,'lock-release'),'release'); await until(() => locker.exitCode !== null,10000).catch(() => locker.kill()); }
    await stop(running, browser); await new Promise(resolve => fixture.close(resolve));
    if (!testRoot.startsWith(path.join(root, 'build', 'update-qa') + path.sep)) throw Error('Unsafe test cleanup.');
    if (!process.env.DUBLINE_QA_KEEP) await fsp.rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { until, browserFor, workspace, stop, importFixture };
