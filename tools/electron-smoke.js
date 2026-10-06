// Smoke-test the packaged Electron app through its Chromium debugging endpoint.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const puppeteer = require('puppeteer-core');
const AdmZip = require('adm-zip');
const { launchBrowser, openPlayer, buildFixturePack } = require('../e2e/helpers');

const root = path.join(__dirname, '..');
const executable = process.env.DUBLINE_SMOKE_EXE
  ? path.resolve(root, process.env.DUBLINE_SMOKE_EXE)
  : process.argv.includes('--portable')
    ? path.join(root, 'dist', 'Dubline.exe')
    : path.join(root, 'dist', 'win-unpacked', 'Dubline.exe');
if (!fs.existsSync(executable)) throw new Error('Build the app with npm run dist first.');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function endpointReady(port) {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/json/version`, response => {
      response.resume(); resolve(response.statusCode === 200);
    });
    request.once('error', () => resolve(false));
    request.setTimeout(500, () => { request.destroy(); resolve(false); });
  });
}

async function waitForTunnel(url) {
  const https = require('node:https');
  const deadline = Date.now() + 90000;
  let reason = '';
  process.stdout.write('Waiting for Cloudflare DNS and tunnel readiness.\n');
  while (Date.now() < deadline) {
    const ready = await new Promise(resolve => {
      const request = https.get(url, response => {
        response.resume(); reason = 'HTTP ' + response.statusCode;
        resolve(response.statusCode >= 200 && response.statusCode < 400);
      });
      request.on('error', error => { reason = error.message; resolve(false); });
      request.setTimeout(3000, () => request.destroy(new Error('Tunnel request timed out')));
    });
    if (ready) return;
    await wait(1000);
  }
  throw new Error('Cloudflare DNS/tunnel did not become reachable: ' + reason);
}

async function main() {
  const hostingMode = process.argv[2] === 'cloudflare' ? 'cloudflare' : 'porthole';
  const debugPort = await freePort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-electron-smoke-'));
  const storageDestination = process.argv.includes('--storage') ? fs.mkdtempSync(path.join(root, '.storage-packaged-')) : '';
  if (storageDestination) {
    fs.mkdirSync(path.join(userData,'uploads')); fs.writeFileSync(path.join(userData,'uploads','storage-marker'),'preserve existing project media');
    fs.writeFileSync(path.join(userData,'storage.json'),JSON.stringify({version:1,root:userData,pending:path.join(storageDestination,'Dubline')}));
  }
  const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, '--disable-gpu',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], {
    cwd: root,
    env: { ...process.env, DUBLINE_USER_DATA_DIR: userData },
    stdio: 'ignore',
    windowsHide: true
  });
  let browser;
  let guestBrowser;
  let serverPort;
  let succeeded = false;
  try {
    for (let attempt = 0; attempt < 120 && !(await endpointReady(debugPort)); attempt++) await wait(250);
    assert.equal(await endpointReady(debugPort), true, 'Electron debugging endpoint did not start');
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` });
    let launcher;
    for (let attempt = 0; attempt < 40 && !launcher; attempt++) {
      launcher = (await browser.pages()).find(page => page.url().includes('electron-launcher.html'));
      if (!launcher) await wait(250);
    }
    assert.ok(launcher, 'Launcher window did not open');
    assert.equal(await launcher.$$eval('.mode', nodes => nodes.length), 3);
    await launcher.waitForFunction(() => document.getElementById('launcherVersion')?.textContent.startsWith('Dubline v'));
    assert.equal(await launcher.$eval('#launcherVersion', node => node.textContent), `Dubline v${require('../package.json').version}`);
    assert.equal(await launcher.evaluate(() => document.documentElement.lang), 'en', 'first launch must be English');
    await launcher.select('#language', 'uk');
    await launcher.$eval(`[data-mode="${hostingMode}"]`, button => button.click());
    await launcher.$eval('#startHost', button => button.click());

    let host;
    for (let attempt = 0; attempt < 80 && !host; attempt++) {
      host = (await browser.pages()).find(page => /^http:\/\/127\.0\.0\.1:\d+\//.test(page.url()));
      if (!host) await wait(250);
    }
    assert.ok(host, 'Host room did not open');
    const diagnostics = [];
    host.on('console', message => diagnostics.push(`console: ${message.text()}`));
    host.on('pageerror', error => diagnostics.push(`page: ${error.message}`));
    let desktopReady = false;
    for (let attempt = 0; attempt < 60 && !desktopReady; attempt++) {
      desktopReady = await host.evaluate(() => !!document.body?.classList.contains('desktop-mode'));
      if (!desktopReady) await wait(250);
    }
    const bridgeState = await host.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      hasDesktopBridge: !!window.dublineDesktop,
      bodyClass: document.body?.className || ''
    }));
    assert.equal(desktopReady, true, `Desktop UI did not initialize: ${JSON.stringify(bridgeState)} ${diagnostics.join(' | ')}`);
    if (storageDestination) {
      const info=await host.evaluate(()=>window.dublineDesktop.getStorage()); assert.equal(info.root,path.join(storageDestination,'Dubline'));assert.equal(info.pending,'');
      assert.equal(fs.readFileSync(path.join(info.root,'uploads','storage-marker'),'utf8'),'preserve existing project media');
      assert.equal(fs.existsSync(path.join(userData,'uploads')),false);
      await host.evaluate(()=>openSettingsModal());await host.waitForFunction(()=>!!document.getElementById('desktopStoragePath').textContent);
      assert.equal(await host.$eval('#desktopStoragePath',node=>node.textContent),info.root);await host.evaluate(()=>closeSettingsModal());
      process.stdout.write('Exact packaged EXE applied pending storage move to the workspace drive.\n');
    }
    assert.equal(await host.evaluate(() => DublineI18n.getLanguage()), 'uk', 'launcher language must follow into the server origin');
    await host.evaluate(async () => { DublineI18n.setLanguage('en'); await window.dublineDesktop.setLanguage('en'); });
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'language.json'), 'utf8')), 'en');
    await host.waitForFunction(() => Number(document.getElementById('desktopHostingPort')?.textContent) >= 38473);
    const result = await host.evaluate(() => ({
      port: Number(document.getElementById('desktopHostingPort').textContent),
      mode: document.querySelector('.hosting-mode.active')?.dataset.hostingMode,
      inviteUrl: document.getElementById('desktopInviteUrl').value
    }));
    assert.ok(result.port >= 38473 && result.port <= 38637, `Unexpected host port ${result.port}`);
    assert.equal(result.mode, hostingMode);
    serverPort = result.port;
    // Files are served only to the host and PIN guests: the native window passes, a stranger does not
    await host.waitForFunction(() => typeof session !== 'undefined' && !!session);
    assert.equal(await host.evaluate(async () => (await fetch('/api/server-packs')).status), 200, 'the host cannot reach its pack library');
    assert.equal((await fetch(`http://127.0.0.1:${result.port}/api/server-packs`)).status, 403, 'a stranger can list the pack library');
    if (hostingMode === 'cloudflare') {
      await host.waitForFunction(() => document.getElementById('desktopInviteUrl')?.value.startsWith('https://'), { timeout: 90000 });
      result.inviteUrl = await host.$eval('#desktopInviteUrl', input => input.value);
      assert.match(result.inviteUrl, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    }
    await host.evaluate(() => {
      modalNickInput.value = 'Smoke Host';
      handleNickSubmit(new Event('submit', { cancelable: true }));
      localStorage.setItem('dubline_help_seen', '1');
      closeHelpModal();
    });
    await host.waitForFunction(() => myName === 'Smoke Host' && amHost());
    await (await host.$('#zipInput')).uploadFile(buildFixturePack());
    await host.waitForFunction(() => session.loaded && session.lines.length === 4 && video.readyState >= 2, { timeout: 30000 }).catch(async error => {
      const media = await host.evaluate(() => ({loaded:session?.loaded,lines:session?.lines?.length,readyState:video.readyState,source:video.currentSrc,error:video.error?.message,file:zipInput.files[0]?.name,disabled:zipInput.disabled}));
      throw Error(error.message+': '+JSON.stringify({media,diagnostics}));
    });
    const pin = await host.evaluate(async () => (await window.dublineDesktop.getStatus()).pin);
    guestBrowser = await launchBrowser(result.port);
    const guestUrl = hostingMode === 'cloudflare' ? result.inviteUrl : host.url();
    if (hostingMode === 'cloudflare') await waitForTunnel(guestUrl);
    const guest = await openPlayer(guestBrowser, guestUrl, 'Smoke Guest');
    // The guest's own warnings (e.g. a discarded or empty take) end up in a failure report
    guest.on('console', message => {
      if (['warning', 'warn'].includes(message.type()) && /\[Dubline\]/.test(message.text())) diagnostics.push(`guest: ${message.text()}`);
    });
    await guest.waitForFunction(() => document.getElementById('passwordModal').style.display === 'flex');
    await guest.evaluate(code => {
      passwordNickInput.value = 'Smoke Guest';
      passwordInput.value = code;
      submitRoomPassword(new Event('submit', { cancelable: true }));
    }, pin);
    await guest.waitForFunction(() => session && session.loaded && session.lines.length === 4 && video.readyState >= 2, { timeout: 60000 });
    // The Audio group starts collapsed: open it, as a user would
    await host.evaluate(() => { localStorage.setItem('dubline_audio_collapsed', '0'); renderTimeline(); });
    assert.equal(await host.evaluate(() => document.querySelectorAll('.studio-audio-row').length), 3);
    await guest.waitForFunction(() => document.querySelector('[data-audio-channel=original] .studio-wave-source')?.textContent === t('studio.videoAudio'));
    assert.equal(await host.$eval('[data-audio-channel=original] .studio-wave-source', el => el.textContent), 'Audio from video');
    const waveform = await host.evaluate(async () => {
      const response = await fetch(`/api/audio-waveform?${new URLSearchParams({ room: currentRoom, sessionId: session.activeSessionId, channel: 'backing' })}`);
      if (!response.ok) throw new Error(await response.text()); return response.json();
    });
    assert.ok(waveform.duration > 11 && waveform.peaks.some(value => value > 0));
    await host.evaluate(() => updateProjectAudio('backing', 'offset', -0.123));
    await guest.waitForFunction(() => session.projectAudio.backing.offset === -0.123);
    await guest.select('[data-studio-mix]', 'monitor');
    await guest.evaluate(() => { const input = document.querySelector('#volBacking'); input.value = '25'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await guest.evaluate(() => studioPlaybackVolumes().backing), 0.25);
    assert.equal(await guest.evaluate(() => readRenderGains().backing), 1);
    await host.evaluate(() => updateProjectAudio('backing', 'offset', 0));
    await guest.waitForFunction(() => session.projectAudio.backing.offset === 0);
    assert.equal(await guest.evaluate(() => amHost()), false, 'PIN guest gained host rights');
    process.stdout.write('PIN guest joined and loaded packaged scene media.\n');

    await host.evaluate(() => setStudioMode('edit'));
    await guest.waitForFunction(() => session.mode === 'edit');
    const created = await guest.evaluate(() => queueEditorRequest(() => ['editor_create_line', {
      character: 'Smoke role', caption: 'Packaged smoke line', start: 1.234, end: 2.345
    }]));
    assert.equal(created.ok, true);
    await host.waitForFunction(id => session.lines.some(line => line.id === id), {}, created.line.id);
    const validForm = await guest.evaluate(id => {
      selectLine(session.lines.find(line => line.id === id));
      document.getElementById('editorCaption').value = 'Edited packaged line';
      document.getElementById('editorEnd').value = '2.456';
      return document.getElementById('editorLineForm').checkValidity();
    }, created.line.id);
    assert.equal(validForm, true, 'millisecond form is invalid');
    await guest.click('#editorLineForm button[type="submit"]');
    await host.waitForFunction(id => session.lines.find(line => line.id === id)?.caption === 'Edited packaged line', {}, created.line.id);
    assert.equal(await host.evaluate(id => session.lines.find(line => line.id === id).end, created.line.id), 2.456);
    assert.equal((await guest.evaluate(() => editorUndo())).undone, 1);
    await host.waitForFunction(id => session.lines.find(line => line.id === id)?.caption === 'Packaged smoke line', {}, created.line.id);
    await guest.waitForFunction(id => session.lines.find(line => line.id === id)?.end === 2.345, {}, created.line.id);
    await guest.evaluate(() => {
      document.getElementById('editorCaption').value = 'Unsaved packaged draft';
      document.getElementById('editorCaption').dispatchEvent(new Event('input', { bubbles: true }));
    });
    await host.evaluate(() => claimCharacter('Hero'));
    await guest.waitForFunction(() => session.characterClaims.Hero === 'Smoke Host');
    assert.equal(await guest.$eval('#editorCaption', input => input.value), 'Unsaved packaged draft');
    await guest.evaluate(id => reloadEditorDraft(id), created.line.id);
    await guest.evaluate(() => claimCharacter('Smoke role'));
    await guest.waitForFunction(() => session.characterClaims['Smoke role'] === 'Smoke Guest');
    await host.evaluate(() => setStudioMode('dub'));
    await guest.waitForFunction(() => session.mode === 'dub');
    const preparation = await guest.evaluate(async id => {
      selectLine(session.lines.find(line => line.id === id));
      preRollSeconds = 5;
      await handleStudioRecord(id);
      window.smokeRecordingBegan = performance.now();
      return { audioStart: currentRecordingStartTime, paused: video.paused, state: recordState };
    }, created.line.id);
    assert.equal(preparation.audioStart, -3.766);
    assert.equal(preparation.paused, true);
    assert.equal(preparation.state, 'preparing');
    await guest.waitForFunction(() => recordState === 'recording', { timeout: 12000 });
    assert.ok(await guest.evaluate(() => performance.now() - smokeRecordingBegan >= 4850), 'preparation was shorter than five seconds');
    await host.waitForFunction(id => !!session.lines.find(line => line.id === id)?.audioUrl, { timeout: 30000 }, created.line.id).catch(async error => {
      const state = await guest.evaluate(() => ({ recording: recordState, videoTime: video.currentTime, videoPaused: video.paused, readyState: video.readyState,
        recorder: mediaRecorder?.state, pendingUploads: pendingTakes.size, selected: selectedLine?.id }));
      throw new Error(`${error.message}: ${JSON.stringify({ state, dialogs: guest.dialogs, errors: guest.errors, diagnostics: diagnostics.filter(message => message.startsWith('page:') || message.startsWith('guest:')) })}`);
    });
    await guest.evaluate(id => {
      selectLine(session.lines.find(line => line.id === id));
      const input = document.querySelector('[data-clip-field=volume]');
      input.value = '64'; input.dispatchEvent(new Event('change', { bubbles: true }));
    }, created.line.id);
    await host.waitForFunction(id => session.lines.find(line => line.id === id)?.volume === 0.64, {}, created.line.id);
    await host.evaluate(id => {
      selectLine(session.lines.find(line => line.id === id));
      const input = document.querySelector('[data-clip-field=pan]');
      input.value = '-35'; input.dispatchEvent(new Event('change', { bubbles: true }));
    }, created.line.id);
    await guest.waitForFunction(id => session.lines.find(line => line.id === id)?.pan === -0.35, {}, created.line.id);
    await host.evaluate(() => {
      const select = document.querySelector('[data-clip-field=effect]');
      select.value = 'radio'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await host.waitForFunction(() => !!document.querySelector('[data-clip-field=effectAmount]'));
    await host.evaluate(() => {
      const input = document.querySelector('[data-clip-field=effectAmount]');
      input.value = '45'; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await guest.waitForFunction(id => session.lines.find(line => line.id === id)?.effectAmount === 0.45, {}, created.line.id);
    const channels = await host.evaluate(async id => (await renderCharacterStem([session.lines.find(line => line.id === id)], 12)).numberOfChannels, created.line.id);
    assert.equal(channels, 2);
    process.stdout.write('Packaged clip author/host controls and stereo stem render passed.\n');
    await host.evaluate(() => socket.emit('set_blind_mode', { enabled: true }));
    await host.waitForFunction(id => session.blindMode && !canHearLine(session.lines.find(line => line.id === id)), {}, created.line.id);
    await host.evaluate(() => revealAllTakes());
    await host.waitForFunction(id => canHearLine(session.lines.find(line => line.id === id)), {}, created.line.id);
    await guest.evaluate(() => { socket.disconnect(); socket.connect(); });
    await guest.waitForFunction(() => socket.connected && myName === 'Smoke Guest' && session.loaded);

    const archive = await host.evaluate(async () => {
      const response = await fetch('/api/export-voxalike-pack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: currentRoom, clientId })
      });
      if (!response.ok) throw new Error(await response.text());
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    });
    const zip = new AdmZip(Buffer.from(archive, 'base64'));
    const lineEntries = zip.getEntries().filter(entry => /^\d+_.+\.ini$/.test(entry.entryName));
    assert.equal(lineEntries.length, 5);
    assert.ok(lineEntries.some(entry => zip.readAsText(entry).includes('Packaged smoke line')));
    await host.evaluate(() => toggleExpandedVideo());
    assert.equal(await host.evaluate(() => document.body.classList.contains('video-expanded')), true);
    await host.evaluate(() => toggleExpandedVideo());
    const portable = await host.evaluate(async () => {
      const before = { id:session.activeSessionId, title:session.title, lines:session.lines.length, takes:session.lines.filter(line=>line.audioUrl).length, clip:session.lines.find(line=>line.audioUrl) };
      const saved = await fetch('/api/export-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:currentRoom,clientId,sessionId:before.id})});
      if(!saved.ok)throw Error(await saved.text());
      const form=new FormData();form.append('clientId',clientId);form.append('sessionId',before.id);form.append('project',await saved.blob(),'portable.dubline');
      const opened=await fetch('/api/import-project?room='+currentRoom,{method:'POST',body:form});if(!opened.ok)throw Error(await opened.text());
      const after=(await opened.json()).session;return {before,after:{id:after.activeSessionId,title:after.title,lines:after.lines.length,takes:after.lines.filter(line=>line.audioUrl).length,clip:after.lines.find(line=>line.audioUrl)}};
    });
    assert.notEqual(portable.after.id,portable.before.id);assert.equal(portable.after.title,portable.before.title);assert.equal(portable.after.lines,portable.before.lines);assert.equal(portable.after.takes,portable.before.takes);
    await guest.waitForFunction(id=>session.activeSessionId===id,{timeout:30000},portable.after.id);
    for (const field of ['volume','pan','effectAmount']) assert.equal(portable.after.clip[field], portable.before.clip[field]);
    process.stdout.write('Packaged .dubline disk save/open retained media, recordings and clip mixes.\n');
    const optimized = await host.evaluate(async () => {
      const source=await (await fetch(session.videoUrl)).blob();
      const form=new FormData();form.append('clientId',clientId);form.append('video',source,'episode.mp4');
      const imported=await fetch('/api/upload-custom?room='+currentRoom+'&optimize=1',{method:'POST',body:form});if(!imported.ok)throw Error(await imported.text());
      const scene=(await imported.json()).session;
      const sound=await (await fetch(scene.audioTracks[0].url)).blob();
      const audio=new FormData();audio.append('clientId',clientId);audio.append('sessionId',scene.activeSessionId);audio.append('soundtrack',sound,'soundtrack.m4a');
      const muxed=await fetch('/api/export-original-video?room='+currentRoom,{method:'POST',body:audio});if(!muxed.ok)throw Error(await muxed.text());
      const prepared=await muxed.json(),download=await fetch(prepared.downloadUrl);
      return {hasOriginal:scene.hasOriginalVideo,sourceUrl:scene.originalVideoUrl,downloadStatus:download.status,bytes:(await download.arrayBuffer()).byteLength,id:scene.activeSessionId};
    });
    assert.equal(optimized.hasOriginal,true);assert.equal(optimized.sourceUrl,undefined);assert.equal(optimized.downloadStatus,200);assert.ok(optimized.bytes>1000);
    await guest.waitForFunction(id=>session.activeSessionId===id && session.hasOriginalVideo,{timeout:30000},optimized.id);
    process.stdout.write('Packaged source/proxy import and original video mux/download passed.\n');
    assert.deepEqual(guest.errors, [], 'guest page errors');
    assert.equal(diagnostics.some(message => message.startsWith('page:')), false, diagnostics.join(' | '));
    succeeded = true;
    process.stdout.write(`Packaged Electron ${hostingMode} smoke passed: import, shared edit/Undo, Dub, recording, Blind Mode, reconnect and ZIP export (${path.basename(path.dirname(executable))}/${path.basename(executable)}).\n`);
  } finally {
    if (guestBrowser) await guestBrowser.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt++) await wait(200);
    if (child.exitCode === null) child.kill();
    for (let attempt = 0; attempt < 40 && await endpointReady(debugPort); attempt++) await wait(250);
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (storageDestination) {
      assert.equal(path.dirname(path.resolve(storageDestination)),path.resolve(root),'temporary storage must remain inside the workspace');
      fs.rmSync(storageDestination,{recursive:true,force:true,maxRetries:10,retryDelay:200});
    }
  }
  if (succeeded && serverPort) {
    await assert.rejects(fetch(`http://127.0.0.1:${serverPort}/api/server-packs`), 'packaged server was left running after closing the app');
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
