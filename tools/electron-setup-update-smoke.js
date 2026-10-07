// Exact NSIS A→B, real electron-updater differential reconstruction and HKCU ownership.
// Refuses to touch an existing Dubline installation; run in a clean Windows profile.
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const assert = require('node:assert/strict');
const { launch, wait } = require('./packaged-test-driver');
const { until, browserFor, workspace, stop, importFixture } = require('./electron-portable-update-smoke');
const { associationOperation, portableProgId } = require('../electron-project-association');
const { fileHash } = require('../electron-managed-files');
const aVersion = require('../package.json').version, bParts = aVersion.split('.').map(Number); bParts[2]++;
const bVersion = bParts.join('.');
const root = path.resolve(__dirname, '..'), aOutput = path.join(root, 'dist'), bOutput = path.join(root, 'build', 'update-qa', bVersion);
const isolatedSetup = process.argv.includes('--isolated-setup');
const aSetupOutput = isolatedSetup ? path.join(root,'build','update-qa','setup-isolated',aVersion) : aOutput;
const bSetupOutput = isolatedSetup ? path.join(root,'build','update-qa','setup-isolated',bVersion) : bOutput;
const fixtureIdentity = isolatedSetup ? { setup:'io.github.dmbai009.Dubline.QASetup.Project',shortcutName:'Dubline Setup QA',displayName:'Dubline Setup QA' } : {};
function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore','pipe','pipe'] }); let output = '';
    const capture = bytes => { output = (output + bytes.toString()).slice(-16384); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('Native installer failed: ' + code + '\n' + output)));
  });
}
function registry(operation, jobFile) {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'setup-association-fixture.ps1'), '-Operation', operation, '-JobFile', jobFile],
    { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (error, stdout, stderr) => { if (error) reject(Error(stderr || error.message)); else { try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch (error) { reject(error); } } }));
}
async function main() {
  const testRoot = await fsp.mkdtemp(path.join(root, 'build', 'update-qa', 'setup-run-'));
  const install = path.join(testRoot, 'Installed Dubline Україна'), profile = path.join(testRoot, 'profile'), portableExe = path.join(aOutput, 'portable', 'Dubline.exe');
  const jobFile = path.join(testRoot, 'association.json'), foreign = `io.github.dmbai009.Dubline.QA.${crypto.randomUUID().replaceAll('-', '')}.Project`;
  let running, browser, installed = false, portableRegistered = false, fixture;
  let transferred = 0, rangeRequests = 0, fullRequests = 0;
  try {
    await fsp.writeFile(jobFile, JSON.stringify({ foreign, ...fixtureIdentity }));
    const before = await registry('preflight', jobFile);
    if ((await associationOperation('status', portableExe, path.join(root, 'resources', 'project-association.ps1'))).registered) throw Error('The QA Portable path is already registered. Use an isolated copy.');
    await fsp.writeFile(jobFile, JSON.stringify({ foreign, previousDefault: before.extension[''] || '', ...fixtureIdentity }));
    const aName = `Dubline-${aVersion}-win-x64-Setup.exe`, bName = `Dubline-${bVersion}-win-x64-Setup.exe`;
    const wizardReport = path.join(testRoot, 'wizard.json');
    const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (isolatedSetup) {
      const probeReport = path.join(testRoot,'production-wizard.json');
      await run(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'setup-wizard-qa.ps1'),'-SetupFile',path.join(aOutput,aName),'-InstallDirectory',install,'-ReportFile',probeReport,'-ProbeOnly']);
      const probe = JSON.parse(await fsp.readFile(probeReport,'utf8'));
      assert.equal(probe.ok,true); assert.equal(probe.probeOnly,true); assert.equal(probe.pages.directory,true);
      console.log('Exact production Setup wizard: welcome/license, actual destination selection and safe cancel verified alongside the existing installation.');
    }
    installed = true;
    await run(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'setup-wizard-qa.ps1'),'-SetupFile',path.join(aSetupOutput,aName),'-InstallDirectory',install,'-ReportFile',wizardReport]);
    const wizard = JSON.parse(await fsp.readFile(wizardReport, 'utf8'));
    assert.equal(wizard.ok, true); assert.equal(wizard.directory, install);
    assert.deepEqual(wizard.pages, { welcome:true,license:true,directory:true,finish:true,launchUnchecked:true });
    console.log('Exact Setup wizard passed: welcome/license, real destination textbox with Unicode/spaces, installation progress and optional launch unchecked.');
    assert.ok(fs.existsSync(path.join(install, 'Dubline.exe')));
    const aState = await registry('status', jobFile);
    assert.equal(aState.setup.DublineOwner, path.join(install, 'Dubline.exe'));
    assert.equal(aState.command, `"${path.join(install, 'Dubline.exe')}" "%1"`);
    assert.equal(aState.desktopShortcut, true); assert.equal(aState.startMenuShortcut, true); assert.equal(aState.installLocation, install);
    assert.deepEqual(aState.userChoice, before.userChoice);
    assert.equal(await fileHash(path.join(install, 'resources', 'app.asar')), await fileHash(path.join(aOutput, 'portable', 'resources', 'app.asar')));
    await associationOperation('register', portableExe, path.join(root, 'resources', 'project-association.ps1')); portableRegistered = true;
    const foreignState = await registry('foreign', jobFile);
    fixture = http.createServer((request, response) => {
      const name = path.basename(new URL(request.url, 'http://fixture').pathname);
      const file = path.join(name === aName || name === aName + '.blockmap' ? aSetupOutput : bSetupOutput, name);
      if (!['latest.yml', aName, bName, aName + '.blockmap', bName + '.blockmap'].includes(name) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
      const size = fs.statSync(file).size; let start = 0, end = size - 1;
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
        if (!match || +match[2] >= size || +match[1] > +match[2]) { response.writeHead(416); response.end(); return; }
        start = +match[1]; end = +match[2]; response.statusCode = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        if (name === bName) rangeRequests++;
      } else if (name === bName) fullRequests++;
      response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('Content-Length', end - start + 1);
      const stream = fs.createReadStream(file, { start, end }); if (name === bName) stream.on('data', bytes => { transferred += bytes.length; }); stream.pipe(response);
    });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${fixture.address().port}`;
    running = await launch(path.join(install, 'Dubline.exe'), profile);
    browser = await browserFor(running); const page = await workspace(browser);
    await importFixture(page);
    const identity = await page.evaluate(() => ({ clientId, id: session.activeSessionId }));
    const buildInfo = await page.evaluate(() => window.dublineDesktop.getBuildInfo());
    assert.equal(buildInfo.version, aVersion); assert.equal(buildInfo.channel, 'github-setup');
    assert.match(buildInfo.commit, /^[a-f0-9]{40}$/); assert.equal(buildInfo.electronVersion, require('electron/package.json').version);
    const projectFile = path.join(testRoot, 'Другой проект.dubline');
    const { exportProject } = require('../server/projects');
    const { fixtureVideoPath } = require('../e2e/helpers');
    const scene = { loaded:true,title:'Coexistence project',kind:'custom',mode:'edit',videoUrl:'video',trackOrder:['Role'],lines:[{id:1,character:'Role',caption:'Coexistence',start:1,end:2}],audioTracks:[] };
    await fsp.writeFile(projectFile, (await exportProject(scene, () => fixtureVideoPath())).buffer);
    const primaryServer = await running.inspector.evaluate('globalThis.__dublineTestServerPid()');
    await running.inspector.evaluate("globalThis.__coexistenceConfirms=0;require('electron').dialog.showMessageBox=async()=>{globalThis.__coexistenceConfirms++;return {response:0};}");
    const secondary = spawn(portableExe, [projectFile,'--disable-gpu'], {windowsHide:true,env:{...process.env,DUBLINE_USER_DATA_DIR:profile},stdio:'ignore'});
    assert.equal(await Promise.race([new Promise(resolve=>secondary.once('exit',resolve)),wait(15000).then(()=>{secondary.kill();throw Error('Secondary Portable did not exit.');})]),0);
    await until(()=>running.inspector.evaluate('globalThis.__coexistenceConfirms===1'));
    assert.equal(await running.inspector.evaluate('globalThis.__dublineTestServerPid()'),primaryServer);
    assert.equal(await page.evaluate(()=>session.activeSessionId),identity.id,'canceled handed-off request preserves the Setup workspace');
    console.log('Exact Setup + Portable share one profile: real secondary Portable exits and primary Setup receives the project request; no second server.');
    await running.inspector.evaluate(`(async()=>{ const updater = globalThis.__dublineTestUpdater().updater; Object.defineProperty(updater.app, 'baseCachePath', { value: ${JSON.stringify(path.join(profile, 'update-cache'))} }); updater.setFeedURL({ provider:'generic', url:${JSON.stringify(origin)}, useMultipleRangeRequest:false }); const helper = await updater.getOrCreateDownloadHelper(); const fs=require('node:fs'); fs.mkdirSync(helper.cacheDir,{recursive:true}); fs.copyFileSync(${JSON.stringify(path.join(aSetupOutput, aName))},require('node:path').join(helper.cacheDir,'installer.exe')); fs.copyFileSync(${JSON.stringify(path.join(aSetupOutput, aName + '.blockmap'))},require('node:path').join(helper.cacheDir,'current.blockmap')); })()`);
    await running.inspector.evaluate('globalThis.__dublineTestUpdater().check()');
    const status = await page.evaluate(() => window.dublineDesktop.getUpdateStatus());
    assert.equal(status.state, 'downloaded', JSON.stringify(status)); assert.ok(rangeRequests > 0); assert.equal(fullRequests, 0);
    const fullSize = (await fsp.stat(path.join(bSetupOutput, bName))).size;
    assert.ok(transferred < fullSize * .75, `Expected a small app-only delta: ${transferred}/${fullSize}`);
    const reconstructed = await running.inspector.evaluate('globalThis.__dublineTestUpdater().updater.installerPath');
    assert.equal(await fileHash(reconstructed), await fileHash(path.join(bSetupOutput, bName)));
    await page.evaluate(() => { recordState = 'preparing'; }); assert.equal((await page.evaluate(() => window.dublineDesktop.openUpdate())).code, 'busy'); await page.evaluate(() => { recordState = 'idle'; });
    await until(() => running.inspector.evaluate('globalThis.__dublineTestUpdater().busy().then(value => !value)'));
    // Keep the installer real; only its GUI/OS relaunch delivery is controlled.
    await running.inspector.evaluate(`(()=>{const updater=globalThis.__dublineTestUpdater().updater;updater.installDirectory=${JSON.stringify(install)};const original=updater.quitAndInstall.bind(updater);updater.quitAndInstall=()=>original(true,false);})()`);
    const closed = new Promise(resolve => running.child.once('exit', resolve)); void page.evaluate(() => window.dublineDesktop.openUpdate()).catch(() => {});
    await wait(150); running.inspector.close(); browser.disconnect(); browser = null; await Promise.race([closed, wait(15000).then(() => { throw Error('Installed app did not shut down.'); })]); running = null;
    await until(async () => JSON.parse(await fsp.readFile(path.join(install, 'resources', 'dubline-distribution.json'), 'utf8')).version === bVersion, 90000);
    assert.equal(await fileHash(path.join(install, 'resources', 'app.asar')), await fileHash(path.join(bOutput, 'portable', 'resources', 'app.asar')));
    running = await launch(path.join(install, 'Dubline.exe'), profile); browser = await browserFor(running); const reopened = await workspace(browser);
    assert.equal(await running.inspector.evaluate("require('electron').app.getVersion()"), bVersion); assert.equal(await reopened.evaluate(() => clientId), identity.clientId);
    const updated = await registry('status', jobFile); assert.deepEqual(updated.userChoice, before.userChoice); assert.equal(updated.extension[''], foreignState.extension['']); assert.ok(Object.hasOwn(updated.openWith, portableProgId(portableExe)));
    assert.equal(updated.installLocation, install, 'update reuses the chosen installation folder');
    await stop(running, browser); running = browser = null;
    await run(path.join(install, 'Uninstall Dubline.exe'), ['/S']); installed = false;
    await until(async () => !(await registry('status', jobFile)).setup.DublineOwner, 30000);
    const uninstalled = await registry('status', jobFile); assert.deepEqual(uninstalled.setup, {}); assert.deepEqual(uninstalled.userChoice, before.userChoice); assert.equal(uninstalled.extension[''], foreignState.extension['']); assert.ok(Object.hasOwn(uninstalled.openWith, portableProgId(portableExe))); assert.ok(Object.hasOwn(uninstalled.openWith, foreign));
    assert.ok(fs.existsSync(profile), 'uninstall preserves userData');
    assert.equal(uninstalled.desktopShortcut, false); assert.equal(uninstalled.startMenuShortcut, false); assert.equal(uninstalled.installLocation, '');
    if (isolatedSetup) {
      assert.deepEqual(uninstalled.productionSetup,before.productionSetup);
      assert.equal(uninstalled.productionDesktop,before.productionDesktop);
      assert.equal(uninstalled.productionStartMenu,before.productionStartMenu);
      assert.equal(uninstalled.productionInstallerCache,before.productionInstallerCache);
      console.log('Existing production Setup handler and desktop/Start menu shortcuts preserved byte-for-byte during isolated QA.');
    }
    console.log(`Exact Setup A→B passed: ${transferred}/${fullSize} bytes (${(100*transferred/fullSize).toFixed(1)}%), ${rangeRequests} ranges, verified installer SHA-256, same profile and ASAR parity; HKCU ownership/update/uninstall preserves Portable, foreign handlers and UserChoice.`);
  } catch (error) { console.error(running?.log()); throw error; }
  finally {
    await stop(running, browser); if (fixture) await new Promise(resolve => fixture.close(resolve));
    if (installed && fs.existsSync(path.join(install, 'Uninstall Dubline.exe'))) await run(path.join(install, 'Uninstall Dubline.exe'), ['/S']);
    if (portableRegistered) await associationOperation('unregister', portableExe, path.join(root, 'resources', 'project-association.ps1'));
    await registry('cleanup', jobFile).catch(() => {});
    if (isolatedSetup) {
      const cache=path.join(process.env.LOCALAPPDATA,'Dubline-setupqa-updater','installer.exe');
      const hash=await fileHash(cache).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(hash && [await fileHash(path.join(aSetupOutput,`Dubline-${aVersion}-win-x64-Setup.exe`)),await fileHash(path.join(bSetupOutput,`Dubline-${bVersion}-win-x64-Setup.exe`))].includes(hash))await fsp.unlink(cache);
    }
    if (!testRoot.startsWith(path.join(root, 'build', 'update-qa') + path.sep)) throw Error('Unsafe QA cleanup.');
    await fsp.rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
