// Production Electron Guest/preload, fake physical input; no DSP or room API mocks.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
if (!process.versions.electron) {
  const os = require('node:os'), { spawn, spawnSync } = require('node:child_process');
  const { startServer, launchBrowser, openPlayer, loadFixture, waitFor } = require('../e2e/helpers');
  (async () => {
    let server, browser; const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-native-noise-'));
    try {
      const microphone = path.join(directory, 'noise.wav');
      const generated = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=.015:duration=60:seed=12', '-ar', '48000', '-ac', '1', microphone], { windowsHide: true }); assert.equal(generated.status, 0, String(generated.stderr));
      server = await startServer(); browser = await launchBrowser(server.port);
      const host = await openPlayer(browser, server.url('native-noise'), 'Host'); await loadFixture(host);
      const environment = { ...process.env, DUBLINE_USER_DATA_DIR: path.join(directory, 'profile'), DUBLINE_NOISE_RESULT: path.join(directory, 'result.json') }; delete environment.ELECTRON_RUN_AS_NODE;
      await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename, '--dubline-join=' + encodeURIComponent(server.url('native-noise', '26.0.0.1')), '--host-resolver-rules=MAP 26.0.0.1 127.0.0.1', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + microphone + '%noloop'], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = ''; child.stdout.on('data', data => { log += data; process.stdout.write(data); }); child.stderr.on('data', data => { log += data; });
        const timer = setTimeout(() => { child.kill(); reject(Error('Native noise timeout: ' + log)); }, 90000);
        child.once('error', reject); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(log)); });
      });
      const result = JSON.parse(fs.readFileSync(environment.DUBLINE_NOISE_RESULT, 'utf8'));
      await waitFor(host, () => session.lines.find(line => line.id === 1).audioUrl);
      const heard = await host.evaluate(async () => { const line = session.lines.find(line => line.id === 1), pcm = (await getProcessedTake(line)).getChannelData(0); return { samples: pcm.length, energy: pcm.reduce((sum, value) => sum + value * value, 0), profile: line.noiseProfileId }; });
      assert.equal(heard.profile, result.profile); assert.equal(heard.samples, result.samples); assert.ok(Math.abs(heard.energy - result.energy) < 1e-6, JSON.stringify({ heard, result }));
      const bytes = await host.evaluate(async () => { const snapshot = await prepareSafeSnapshot('project'); const response = await fetch('/api/export-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, ...snapshot }) }); if (!response.ok) throw Error(await response.text()); return Array.from(new Uint8Array(await response.arrayBuffer())); });
      const project = require('../server/projects').readProject(Buffer.from(bytes)); assert.equal(project.manifest.formatVersion, 7); assert.equal(project.manifest.project.lines[0].take.noiseProfileId, result.profile);
      console.log('Native noise calibration / zero preparation / Space / private A/B / host parity / version-7 project PASSED.');
    } finally { await browser?.close(); await server?.cleanup(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron'); app.setAppPath(root); BrowserWindow.prototype.show = function () {};
  require('../electron-main');
  const until = async (fn, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('Native noise condition timed out'); };
  app.whenReady().then(async () => {
    try {
      let window; await until(async () => { window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http')); return !!window; });
      const evaluate = code => window.webContents.executeJavaScript(code, true);
      await until(() => evaluate('socket.connected && nickModal.style.display === "flex"'));
      await evaluate("modalNickInput.value='Native actor';handleNickSubmit({preventDefault(){}});closeHelpModal();void 0;");
      await until(() => evaluate("session.loaded && myName==='Native actor'"));
      await until(() => evaluate('p2pConsentDialog.open')); await evaluate('p2pConsentDecline.click();void 0;');
      assert.equal(await evaluate('typeof require'), 'undefined'); assert.equal(await evaluate('typeof dublineDesktop'), 'undefined');
      await evaluate("noiseSuppression=false;userMicGain=1;DublineNoise.open();noiseCalibrate.click();void 0;");
      await until(() => evaluate("noiseStatus.textContent===t('noise.calibratedDraft')"), 18000);
      await evaluate('noiseConfirm.click();void 0;'); await until(() => evaluate('session.noiseReduction?.actors[myName]?.enabled'));
      for (const factor of [1, 1.25, 1.5]) { window.webContents.setZoomFactor(factor); await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(await evaluate('noiseDialog.scrollWidth <= noiseDialog.clientWidth+1 && noiseDialog.getBoundingClientRect().width < innerWidth'), true); }
      window.webContents.setZoomFactor(1);
      await evaluate("noiseClose.click();preRollSeconds=0;localStorage.setItem('dubline_adr','off');socket.emit('claim_character',{character:'Hero',sessionId:session.activeSessionId});void 0;");
      await until(() => evaluate('session.characterClaims.Hero===myName')); await evaluate('selectLine(session.lines.find(l=>l.id===1));recordSelectedLine();void 0;'); await until(() => evaluate("recordState==='recording'"));
      await new Promise(resolve => setTimeout(resolve, 350)); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await until(() => evaluate("recordState==='idle' && session.lines.find(l=>l.id===1).audioUrl && !pendingTakes.size"));
      assert.equal(await evaluate('session.lines.find(l=>l.id===1).noiseProfileId===session.noiseReduction.actors[myName].profileId'), true);
      const before = await evaluate('JSON.stringify(session.lines.find(l=>l.id===1))');
      await evaluate("DublineNoise.open();noiseDialog.querySelector('details').open=true;noiseSample.value='1:'+session.lines.find(l=>l.id===1).takeId;noiseSample.dispatchEvent(new Event('change'));void 0;");
      await until(() => evaluate("noiseStatus.textContent===t('noise.previewOnly') && !noisePreviewPlay.disabled"));
      await evaluate("noiseAB.value='clean';noisePreviewPlay.click();noiseStrength.value=80;noiseStrength.dispatchEvent(new Event('input'));void 0;"); await until(() => evaluate("noiseStatus.textContent===t('noise.previewOnly')"));
      await evaluate('noiseClose.click();void 0;'); assert.equal(await evaluate('JSON.stringify(session.lines.find(l=>l.id===1))'), before);
      const result = await evaluate('(async()=>{const line=session.lines.find(l=>l.id===1),pcm=(await getProcessedTake(line)).getChannelData(0);return{profile:line.noiseProfileId,samples:pcm.length,energy:pcm.reduce((sum,value)=>sum+value*value,0)}})()');
      fs.writeFileSync(process.env.DUBLINE_NOISE_RESULT, JSON.stringify(result)); app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  });
}
