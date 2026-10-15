// Production guest window and narrow export IPC; only the native file picker is mocked.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process'), os = require('node:os');
  const { startServer, launchBrowser, openPlayer, loadFixture } = require('../e2e/helpers');
  (async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-native-export-'));
    let server, browser;
    try {
      server = await startServer(); browser = await launchBrowser(server.port);
      const host = await openPlayer(browser, server.url('native-export'), 'Host'); await loadFixture(host);
      const source = path.join(server.dirs.uploads, (await host.evaluate(() => session.videoUrl)).slice('/uploads/'.length));
      const hash = require('node:child_process').spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-i', source, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], { encoding: 'utf8', windowsHide: true }); assert.equal(hash.status, 0, hash.stderr);
      await new Promise((resolve, reject) => {
        const environment = { ...process.env, DUBLINE_USER_DATA_DIR: path.join(directory, 'profile'), DUBLINE_NATIVE_EXPORT_DIR: directory, DUBLINE_NATIVE_EXPORT_HASH: hash.stdout.trim() };
        delete environment.ELECTRON_RUN_AS_NODE;
        const child = spawn(require('electron'), [__filename, '--dubline-join=' + encodeURIComponent(server.url('native-export', '26.0.0.1')), '--host-resolver-rules=MAP 26.0.0.1 127.0.0.1', '--disable-gpu'], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = ''; child.stdout.on('data', data => { log += data; process.stdout.write(data); }); child.stderr.on('data', data => { log += data; });
        const timer = setTimeout(() => { child.kill(); reject(Error('Native export timeout: ' + log)); }, 90000);
        child.once('error', reject); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(log)); });
      });
    } finally { await browser?.close(); await server?.cleanup(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, dialog } = require('electron');
  app.setAppPath(root); BrowserWindow.prototype.show = function () {};
  let cancelPicker = true, pickerCalls = 0, filename = 'guest.mp4', evaluate;
  dialog.showSaveDialog = async (_window, options) => {
    pickerCalls++; assert.equal(await evaluate('renderInProgress'), false, 'picker precedes rendering');
    assert.ok(options.properties.includes('showOverwriteConfirmation'));
    return cancelPicker ? { canceled: true } : { canceled: false, filePath: path.join(process.env.DUBLINE_NATIVE_EXPORT_DIR, filename) };
  };
  require('../electron-main');
  const until = async (fn, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('Native export condition timed out'); };
  app.whenReady().then(async () => {
    try {
      let window; await until(async () => { window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('http')); return !!window; });
      evaluate = code => window.webContents.executeJavaScript(code, true);
      await until(() => evaluate('socket.connected && nickModal.style.display === "flex"'));
      await evaluate("modalNickInput.value='Native actor';handleNickSubmit({preventDefault(){}});closeHelpModal();void 0;");
      await until(() => evaluate('session.loaded && myName === "Native actor"'));
      await evaluate("if(p2pConsentDialog.open)p2pConsentDecline.click();void 0;");
      await until(() => evaluate('!!localMedia?.videoBlob'));
      assert.equal(await evaluate('typeof require'), 'undefined'); assert.equal(await evaluate('typeof dublineDesktop'), 'undefined');
      assert.deepEqual(await evaluate('Object.keys(dublineVideoExport).sort()'), ['cancel', 'choose', 'commit', 'reveal', 'write']);
      await evaluate("openFilesModal();switchFilesTab('export');void 0;"); await until(() => evaluate('!startRenderBtn.disabled'));
      await evaluate('startVideoRender()'); assert.equal(pickerCalls, 1); assert.equal(fs.existsSync(path.join(process.env.DUBLINE_NATIVE_EXPORT_DIR, filename)), false);
      assert.equal(await evaluate('renderInProgress'), false);
      cancelPicker = false;
      await evaluate('window.exportSignals=0;window.NativeAudioContext=AudioContext;window.AudioContext=class extends NativeAudioContext{createOscillator(){window.exportSignals++;return super.createOscillator();}};void 0;');
      await evaluate('startVideoRender()');
      const movie = path.join(process.env.DUBLINE_NATIVE_EXPORT_DIR, filename); assert.ok(fs.statSync(movie).size > 1000);
      const inspected = await require('../server/video-export-info').inspect(movie); assert.equal(inspected.width, 640); assert.equal(inspected.height, 360);
      assert.ok(Math.abs(inspected.duration - 12) < 0.1); assert.equal(await evaluate('exportSignals'), 1);
      assert.equal(await evaluate('renderProgressBar.style.width'), '100%');
      assert.equal(await evaluate("['takes','audio','video','saving'].every(phase => document.querySelector('[data-phase=' + phase + ']').dataset.state === 'done')"), true);
      assert.equal(await evaluate("document.querySelector('[data-phase=saving] progress').max"), fs.statSync(movie).size);
      assert.equal(fs.readdirSync(process.env.DUBLINE_NATIVE_EXPORT_DIR).some(name => name.endsWith('.part')), false);
      const hashed = require('node:child_process').spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-i', movie, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], { encoding: 'utf8', windowsHide: true }); assert.equal(hashed.status, 0, hashed.stderr); assert.equal(hashed.stdout.trim(), process.env.DUBLINE_NATIVE_EXPORT_HASH);
      filename = 'custom.webm';
      await evaluate("document.querySelector('[name=videoExportMode][value=custom]').click();videoExportFormat.value='webm';videoExportFormat.dispatchEvent(new Event('change'));videoExportResolution.value='240';videoExportResolution.dispatchEvent(new Event('change'));videoExportSound.checked=false;void 0;");
      await until(() => evaluate('!startRenderBtn.disabled')); await evaluate('startVideoRender()');
      const custom = await require('../server/video-export-info').inspect(path.join(process.env.DUBLINE_NATIVE_EXPORT_DIR, filename));
      assert.equal(custom.codec, 'vp9'); assert.equal(custom.height, 240); assert.equal(await evaluate('exportSignals'), 1);
      // A selected ticket cannot write to a caller-supplied path.
      assert.equal(await evaluate("dublineVideoExport.write({ticket:'missing',sessionId:session.activeSessionId,position:0,bytes:new Uint8Array([1]),path:'C:\\\\arbitrary.mp4'}).then(result=>result.ok)"), false);
      const untrusted = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron-guest-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      await untrusted.loadURL(new URL('/api/health', window.webContents.getURL()).href);
      assert.equal(await untrusted.webContents.executeJavaScript("dublineVideoExport.choose({extension:'mp4',sessionId:'scene'}).then(()=>false,error=>error.message.includes('Untrusted'))"), true); untrusted.destroy();
      await evaluate("new Promise(resolve=>{const frame=document.createElement('iframe');frame.srcdoc='<body>Frame</body>';frame.onload=()=>{window.frameExportBridge=typeof frame.contentWindow.dublineVideoExport;frame.remove();resolve();};document.body.append(frame);})");
      assert.equal(await evaluate('frameExportBridge'), 'undefined');
      filename = 'cancelled.mp4'; const existing = path.join(process.env.DUBLINE_NATIVE_EXPORT_DIR, filename); fs.writeFileSync(existing, 'KEEP');
      await evaluate("document.querySelector('[name=videoExportMode][value=fast]').click();void 0;"); await until(() => evaluate('!startRenderBtn.disabled'));
      const openFile = fs.promises.open; let cancellationSeen = false;
      fs.promises.open = async (...args) => {
        const file = await openFile(...args);
        if (path.basename(String(args[0])).startsWith('.cancelled.mp4.')) { const write = file.write.bind(file); file.write = async (...data) => { cancellationSeen = true; await evaluate('cancelVideoRender();void 0;'); await new Promise(resolve => setTimeout(resolve, 100)); return write(...data); }; }
        return file;
      };
      try { await evaluate('startVideoRender()'); } finally { fs.promises.open = openFile; }
      assert.equal(cancellationSeen, true); assert.equal(fs.readFileSync(existing, 'utf8'), 'KEEP'); assert.equal(await evaluate('renderStatusText.textContent === t("exportVideo.cancelled")'), true); assert.equal(await evaluate('exportSignals'), 1);
      assert.equal(fs.readdirSync(process.env.DUBLINE_NATIVE_EXPORT_DIR).some(name => name.endsWith('.part')), false);
      console.log('Native guest: picker before render/cancel, streamed MP4 and WebM, bounded bridge, saved-file signal and cleanup PASS.');
      window.close();
    } catch (error) { console.error(error); app.exit(1); }
  });
}
