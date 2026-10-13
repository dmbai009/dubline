const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, recordTake, waitFor, waitUntil } = require('./helpers');
function ff(args) { const result = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 }); assert.equal(result.status, 0, result.stderr); return result.stdout; }
function videoHash(file) { return ff(['-i', file, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).trim(); }
describe('video export: sources, guest rights, local rendering and bounded settings', { skip: skipReason, timeout: 240000 }, () => {
  let server, browser, host, guest;
  const room = 'video-export';
  async function open(page, mode = 'fast') {
    await page.evaluate(() => { openFilesModal(); switchFilesTab('export'); });
    await waitFor(page, () => videoExportPanel.dataset.ready === 'true');
    await page.click(`[name=videoExportMode][value=${mode}]`);
    await waitFor(page, () => !document.getElementById('startRenderBtn').disabled);
  }
  async function download(page, mode = 'fast', configure) {
    const directory = fs.mkdtempSync(path.join(server.dirs.data, 'video-result-'));
    await (await page.createCDPSession()).send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
    await open(page, mode); if (configure) await configure(page);
    await page.click('#startRenderBtn');
    await waitUntil(() => fs.readdirSync(directory).some(name => /\.(mp4|webm|mkv)$/.test(name)), 60000);
    await waitFor(page, () => !renderInProgress);
    const file = path.join(directory, fs.readdirSync(directory).find(name => /\.(mp4|webm|mkv)$/.test(name)));
    assert.ok(fs.statSync(file).size > 1000); return file;
  }
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); host = await openPlayer(browser, server.url(room), 'Host'); guest = await openPlayer(browser, server.url(room), 'Guest'); await loadFixture(host); await waitFor(guest, () => session?.loaded); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('pack scenes expose real stream metadata to admitted guests but no private original or paths', async () => {
    const result = await guest.evaluate(async () => { const response = await fetch('/api/video-export-info?room=' + currentRoom + '&clientId=' + clientId + '&sessionId=' + session.activeSessionId); return { status: response.status, data: await response.json() }; });
    assert.equal(result.status, 200); assert.equal(result.data.original, null); assert.equal(result.data.originalSame, true);
    assert.ok(result.data.working.width > 0 && result.data.working.height > 0 && result.data.working.bitrate > 0 && result.data.working.fps > 0);
    assert.equal(/uploads|clientId|token|source_video/.test(JSON.stringify(result.data)), false);
    await open(guest); assert.equal(await guest.$eval('[value=original][name=videoExportMode]', button => button.disabled), true);
  });
  test('host and guest fast exports from a Voxalike pack retain the encoded video packets', async () => {
    await claimAndSelect(host, 1); await recordTake(host, 1);
    const source = await host.evaluate(() => session.videoUrl);
    const original = path.join(server.dirs.uploads, decodeURIComponent(source.slice('/uploads/'.length)));
    for (const page of [host, guest]) { const file = await download(page); assert.equal(videoHash(file), videoHash(original)); assert.deepEqual(page.errors, []); }
  });
  test('custom guest export actually re-encodes smaller video, and excessive bitrate/FPS/resolution are disabled', async () => {
    await open(guest, 'custom');
    const bounds = await guest.evaluate(() => ({ info: DublineVideoExportPanel.settings().sourceInfo, resolution: [...videoExportResolution.options].filter(option => option.disabled).map(option => option.value), fps: [...videoExportFps.options].filter(option => option.disabled).map(option => option.value) }));
    assert.ok(bounds.resolution.includes('1080')); assert.ok(bounds.fps.includes('60'));
    await guest.evaluate(() => { videoExportBitrate.value = '999'; videoExportBitrate.dispatchEvent(new Event('input')); });
    await waitFor(guest, () => startRenderBtn.disabled);
    await guest.evaluate(() => { videoExportBitrate.value = String(Math.floor(DublineVideoExportPanel.settings().sourceInfo.bitrate / 2) / 1000000); videoExportBitrate.dispatchEvent(new Event('input')); });
    await waitFor(guest, () => !startRenderBtn.disabled);
    const file = await download(guest, 'custom', async page => {
      await page.evaluate(() => { videoExportBitrate.value = String(Math.floor(DublineVideoExportPanel.settings().sourceInfo.bitrate / 2) / 1000000); videoExportBitrate.dispatchEvent(new Event('input')); });
      await page.select('#videoExportResolution', '240'); await waitFor(page, () => !startRenderBtn.disabled);
      await page.select('#videoExportFps', '15'); await waitFor(page, () => !startRenderBtn.disabled);
    });
    const info = await require('../server/video-export-info').inspect(file);
    assert.ok(info.width <= bounds.info.width && info.height <= bounds.info.height);
    assert.equal(info.height, 240);
    assert.ok(Math.abs(info.fps - 15) < 0.01);
    assert.equal(info.codec, 'avc'); assert.ok(Math.abs(info.duration - 12) < 0.1);
  });
  test('guest WebM export encodes VP9/Opus with the selected geometry', async () => {
    const file = await download(guest, 'custom', async page => { await page.select('#videoExportFormat', 'webm'); await page.select('#videoExportResolution', '240'); await waitFor(page, () => !startRenderBtn.disabled); });
    const info = await require('../server/video-export-info').inspect(file); assert.equal(info.codec, 'vp9'); assert.equal(info.height, 240);
    ff(['-i', file, '-map', '0:a:0', '-f', 'null', '-']);
  });
  test('export lease uses server Blind Mode rules, owner identity and scene checks', async () => {
    await host.evaluate(() => socket.emit('set_blind_mode', { enabled: true, sessionId: session.activeSessionId })); await waitFor(guest, () => session.blindMode);
    const lease = await guest.evaluate(async () => { const response = await fetch('/api/video-export-lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, sessionId: session.activeSessionId, videoUrl: session.videoUrl }) }); return { status: response.status, data: await response.json() }; });
    assert.equal(lease.status, 200); assert.equal(lease.data.takeIds.includes(1), false);
    const denied = await host.evaluate(async ticket => (await fetch('/api/video-export-lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, ticket, release: true }) })).status, lease.data.ticket);
    assert.equal(denied, 403);
    assert.equal(await guest.evaluate(async ticket => (await fetch('/api/video-export-lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, ticket, release: true }) })).status, lease.data.ticket), 200);
    assert.equal(await guest.evaluate(async () => (await fetch('/api/video-export-lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, sessionId: 'stale', videoUrl: session.videoUrl }) })).status), 409);
    await host.evaluate(() => socket.emit('set_blind_mode', { enabled: false, sessionId: session.activeSessionId })); await waitFor(guest, () => !session.blindMode);
  });
  test('snapshot retains a deleted main take until release without freezing other participants', async () => {
    const take = await host.evaluate(() => ({ ...session.lines.find(line => line.id === 1) }));
    const lease = await guest.evaluate(async () => (await fetch('/api/video-export-lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, sessionId: session.activeSessionId, videoUrl: session.videoUrl }) })).json());
    assert.ok(lease.takeIds.includes(1));
    const file = path.join(server.dirs.uploads, path.basename(take.audioUrl)); assert.ok(fs.existsSync(file));
    assert.equal(await host.evaluate(async take => (await fetch('/api/delete-line-audio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, userName: myName, sessionId: session.activeSessionId, lineId: take.id, audioUrl: take.audioUrl, takeId: take.takeId, historyRevision: take.takeHistoryRevision || 0 }) })).status, take), 200);
    await waitFor(guest, () => !session.lines.find(line => line.id === 1).audioUrl); assert.ok(fs.existsSync(file));
    await guest.evaluate(async ticket => fetch('/api/video-export-lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, ticket, release: true }) }), lease.ticket);
    await waitUntil(() => !fs.existsSync(file));
  });
  test('export cards and custom controls fit six themes, three languages and 100/125/150% scaling', async () => {
    await open(guest, 'custom'); await guest.setViewport({ width: 800, height: 650 });
    for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['ru', 'uk', 'en']) for (const zoom of [1, 1.25, 1.5]) {
      await guest.evaluate(({ theme, language, zoom }) => { document.documentElement.dataset.theme = theme; DublineI18n.setLanguage(language); document.body.style.zoom = zoom; }, { theme, language, zoom });
      assert.equal(await guest.$eval('#videoExportPanel', element => element.scrollWidth <= element.clientWidth + 1), true, `${theme}/${language}/${zoom}`);
    }
    await guest.evaluate(() => { document.body.style.zoom = ''; DublineI18n.setLanguage('en'); }); await guest.setViewport({ width: 1280, height: 800 });
  });
  test('windowed 44.1 kHz sources and processed takes match the full mixer across window/duck boundaries', async () => {
    const result = await host.evaluate(async () => {
      const duration = 14, rate = 44100;
      const original = new AudioBuffer({ length: rate * duration, sampleRate: rate, numberOfChannels: 2 });
      for (let channel = 0; channel < 2; channel++) { const data = original.getChannelData(channel); for (let i = 0; i < data.length; i++) data[i] = 0.2 * Math.sin(i * 2 * Math.PI * (220 + channel * 100) / rate); }
      const voice = new AudioBuffer({ length: 48000 * 4, sampleRate: 48000, numberOfChannels: 1 });
      for (let i = 0; i < voice.length; i++) voice.getChannelData(0)[i] = 0.15 * Math.sin(i * 2 * Math.PI * 370 / 48000);
      const sourceUrl = URL.createObjectURL(new Blob([audioBufferToWav(original)], { type: 'audio/wav' })), voiceUrl = URL.createObjectURL(new Blob([audioBufferToWav(voice)], { type: 'audio/wav' }));
      try {
        const snapshot = createExportSnapshot(); snapshot.originalUrl = sourceUrl; snapshot.backingUrl = null;
        snapshot.takes = [{ ...snapshot.scene.lines[0], audioUrl: voiceUrl, audioStart: 6.7, trimStart: 0.2, trimEnd: 3.8, trimEnabled: true, effect: 'telephone', pitch: 2, effectAmount: 0.4, pan: -0.25, volume: 0.8 }];
        snapshot.gains = { ...snapshot.gains, original: 0.8, backing: 0, dub: 0.9, mix: { ...snapshot.gains.mix, autoDuckEnabled: true, autoDuckAmount: 0.6, original: { ...snapshot.gains.mix.original, offset: 0.125 } } };
        const reference = await mixSoundtrack(duration, snapshot.gains, () => {}, snapshot);
        const mb = await import('/vendor/mediabunny/mediabunny.min.mjs'), blocks = [];
        for await (const chunk of DublineVideoExportAudio.chunks(mb, snapshot, duration, () => {}, () => assertExportScene(snapshot))) blocks.push(chunk.buffer);
        let maximum = 0, squared = 0, samples = 0, position = 0;
        for (const block of blocks) { for (let c = 0; c < 2; c++) { const actual = block.getChannelData(c), expected = reference.getChannelData(c); for (let i = 0; i < actual.length; i++) { const difference = actual[i] - expected[position + i]; maximum = Math.max(maximum, Math.abs(difference)); squared += difference * difference; samples++; } } position += block.length; }
        return { maximum, rms: Math.sqrt(squared / samples), frames: position, expected: reference.length, blocks: blocks.length };
      } finally { URL.revokeObjectURL(sourceUrl); URL.revokeObjectURL(voiceUrl); }
    });
    console.log('Windowed mix comparison:', JSON.stringify(result));
    assert.equal(result.frames, result.expected); assert.equal(result.blocks, 2); assert.ok(result.maximum < 0.005, JSON.stringify(result)); assert.ok(result.rms < 0.0005, JSON.stringify(result));
  });
  test('windowed AAC sources preserve decoder delay and the full mix across window boundaries', async () => {
    const encoded = path.join(server.dirs.data, 'comparison.m4a');
    ff(['-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*220*t)|0.2*sin(2*PI*320*t):s=44100:d=14', '-c:a', 'aac', '-b:a', '192k', encoded]);
    const result = await host.evaluate(async base64 => {
      const duration = 14, rate = 44100;
      const original = new AudioBuffer({ length: rate * duration, sampleRate: rate, numberOfChannels: 2 });
      for (let channel = 0; channel < 2; channel++) { const data = original.getChannelData(channel); for (let i = 0; i < data.length; i++) data[i] = 0.2 * Math.sin(i * 2 * Math.PI * (220 + channel * 100) / rate); }
      const voice = new AudioBuffer({ length: 48000 * 4, sampleRate: 48000, numberOfChannels: 1 });
      for (let i = 0; i < voice.length; i++) voice.getChannelData(0)[i] = 0.15 * Math.sin(i * 2 * Math.PI * 370 / 48000);
      const sourceUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), value => value.charCodeAt(0))], { type: 'audio/mp4' })), voiceUrl = URL.createObjectURL(new Blob([audioBufferToWav(voice)], { type: 'audio/wav' }));
      try {
        const snapshot = createExportSnapshot(); snapshot.originalUrl = sourceUrl; snapshot.backingUrl = null;
        snapshot.takes = [{ ...snapshot.scene.lines[0], audioUrl: voiceUrl, audioStart: 6.7, trimStart: 0.2, trimEnd: 3.8, trimEnabled: true, effect: 'telephone', pitch: 2, effectAmount: 0.4, pan: -0.25, volume: 0.8 }];
        snapshot.gains = { ...snapshot.gains, original: 0.8, backing: 0, dub: 0.9, mix: { ...snapshot.gains.mix, autoDuckEnabled: true, autoDuckAmount: 0.6, original: { ...snapshot.gains.mix.original, offset: 0.125 } } };
        const reference = await mixSoundtrack(duration, snapshot.gains, () => {}, snapshot);
        const mb = await import('/vendor/mediabunny/mediabunny.min.mjs'), blocks = [];
        for await (const chunk of DublineVideoExportAudio.chunks(mb, snapshot, duration, () => {}, () => assertExportScene(snapshot))) blocks.push(chunk.buffer);
        let maximum = 0, squared = 0, samples = 0, position = 0, maximumAt = 0; const bins = Array(14).fill(0);
        for (const block of blocks) { for (let c = 0; c < 2; c++) { const actual = block.getChannelData(c), expected = reference.getChannelData(c); for (let i = 0; i < actual.length; i++) { const difference = actual[i] - expected[position + i]; if (Math.abs(difference) > maximum) { maximum = Math.abs(difference); maximumAt = (position + i) / 48000; } bins[Math.min(13, Math.floor((position+i)/48000))] += difference*difference; squared += difference * difference; samples++; } } position += block.length; }
        return { maximum, maximumAt, bins, rms: Math.sqrt(squared / samples), frames: position, expected: reference.length, blocks: blocks.length };
      } finally { URL.revokeObjectURL(sourceUrl); URL.revokeObjectURL(voiceUrl); }
    }, fs.readFileSync(encoded).toString('base64'));
    console.log('Windowed mix comparison:', JSON.stringify(result));
    assert.equal(result.frames, result.expected); assert.equal(result.blocks, 2); assert.ok(result.maximum < 0.005, JSON.stringify(result)); assert.ok(result.rms < 0.0005, JSON.stringify(result));
  });
  test('verified cached video and audio are reused without another media request during export', async () => {
    const cached = await openPlayer(browser, server.url(room, 'dubline.test'), 'Cached actor');
    try {
      await waitFor(cached, () => localMedia?.videoBlob && !mediaDownload);
      let requests = 0; const observed = request => { if (request.url().includes('/uploads/') && request.method() === 'GET') requests++; };
      cached.on('request', observed); const file = await download(cached);
      assert.equal(requests, 0); assert.ok(fs.statSync(file).size > 1000); assert.deepEqual(cached.errors, []);
      cached.off('request', observed);
    } finally { await cached.browserContext().close(); }
  });
  test('a host without AudioEncoder still exports the unchanged original video using real-time audio only', async () => {
    const originalHost = await openPlayer(browser, server.url('original-no-encoder'), 'Original host');
    try {
      await loadFixture(originalHost); await originalHost.evaluate(() => { window.AudioEncoder = undefined; window.AudioDecoder = undefined; });
      const file = await download(originalHost, 'original');
      const source = await originalHost.evaluate(() => session.videoUrl);
      assert.equal(videoHash(file), videoHash(path.join(server.dirs.uploads, source.slice('/uploads/'.length))));
      assert.ok(Math.abs((await require('../server/video-export-info').inspect(file)).duration - 12) < 0.1); assert.deepEqual(originalHost.errors, []);
    } finally { await originalHost.browserContext().close(); }
  });
  test('an ordinary insecure HTTP guest without AudioEncoder really renders a playable file with no file API', async () => {
    const insecureBrowser = await launchBrowser(server.port, { secureOrigin: false });
    const insecure = await openPlayer(insecureBrowser, server.url(room, 'dubline.test'), 'HTTP actor');
    try {
      assert.deepEqual(await insecure.evaluate(() => ({ secure: isSecureContext, encoder: typeof AudioEncoder, native: typeof dublineVideoExport })), { secure: false, encoder: 'undefined', native: 'undefined' });
      await waitFor(insecure, () => session?.loaded && localMedia?.videoBlob);
      const file = await download(insecure);
      const info = await require('../server/video-export-info').inspect(file);
      assert.ok(Math.abs(info.duration - 12) < 0.35, JSON.stringify(info)); assert.ok(info.width <= 640 && info.height <= 360); assert.ok(info.fps > 10, JSON.stringify(info));
      assert.deepEqual(insecure.errors, []);
      await insecure.evaluate(() => { startVideoRender(); }); await waitFor(insecure, () => renderInProgress && !cancelVideoExportBtn.hidden);
      await insecure.click('#cancelVideoExportBtn'); await waitFor(insecure, () => !renderInProgress);
      assert.match(await insecure.$eval('#renderStatusText', element => element.textContent), /cancelled/i); assert.deepEqual(insecure.errors, []);
    } finally { await insecureBrowser.close(); }
  });
});
