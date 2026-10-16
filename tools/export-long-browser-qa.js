// Optional long-media acceptance check. All source files are copied read-only into test storage.
// Usage: node tools/export-long-browser-qa.js <Dubline data folder>
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { startServer, launchBrowser, openPlayer, waitFor, waitUntil } = require('../e2e/helpers');

(async () => {
  let server, browser;
  const sourceRoot = path.resolve(process.argv[2] || ''), output = path.resolve('audit', 'export-long-browser-' + Date.now());
  fs.mkdirSync(output, { recursive: true });
  try {
    const original = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'data', 'rooms.json'), 'utf8')).main;
    const fields = ['loaded', 'title', 'videoUrl', 'backingUrl', 'lines', 'latency', 'takeLatency', 'externalOriginalUrl', 'projectAudio', 'videoHasAudio', 'audioTracks', 'originalTrack', 'videoDuration', 'noiseReduction', 'roleEffects', 'voicePresets', 'originalVideoUrl', 'originalVideoName'];
    const scene = Object.fromEntries(fields.filter(key => original[key] !== undefined).map(key => [key, original[key]]));
    Object.assign(scene, { activeSessionId: 'long-browser', kind: 'custom', mode: 'dub', blindMode: false, characterClaims: {} });
    scene.sessions = { 'long-browser': { ...scene } };
    server = await startServer(); await server.stop();
    fs.writeFileSync(path.join(server.dirs.data, 'rooms.json'), JSON.stringify({ main: scene }));
    const urls = new Set([scene.videoUrl, scene.originalVideoUrl, scene.backingUrl, scene.externalOriginalUrl, ...(scene.audioTracks || []).map(track => track.url), ...scene.lines.map(line => line.audioUrl)].filter(Boolean));
    for (const url of urls) {
      assert.ok(url.startsWith('/uploads/'));
      const relative = url.slice(9), destination = path.resolve(server.dirs.uploads, relative);
      assert.ok(destination.startsWith(server.dirs.uploads + path.sep));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(sourceRoot, 'uploads', relative), destination);
    }
    await server.start(); browser = await launchBrowser(server.port);
    const host = await openPlayer(browser, server.url('main'), 'Host');
    await waitFor(host, () => amHost() && session.loaded);
    const guest = await openPlayer(browser, server.url('main'), 'Guest');
    await waitFor(guest, () => session.loaded);
    await (await guest.createCDPSession()).send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: output });
    const results = [], ff = args => {
      const result = spawnSync(require('ffmpeg-static'), ['-v', 'error', ...args], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
      assert.equal(result.status, 0, result.stderr); return result.stdout;
    };
    const hash = file => ff(['-i', file, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
    const sourceHash = hash(path.join(sourceRoot, 'uploads', scene.videoUrl.slice(9)));
    for (const name of ['fast', 'repeat', 'custom']) {
      const previous = new Set(fs.readdirSync(output)), started = Date.now();
      await guest.evaluate(async name => {
        openFilesModal(); switchFilesTab('export'); await DublineVideoExportPanel.open();
        document.querySelector('[name=videoExportMode][value=' + (name === 'custom' ? 'custom' : 'fast') + ']').click();
        if (name === 'custom') {
          videoExportResolution.value = '360'; videoExportResolution.dispatchEvent(new Event('change'));
          videoExportFormat.value = 'mp4'; videoExportFormat.dispatchEvent(new Event('change'));
        }
        window.longDone = false;
        void startVideoRender().finally(() => window.longDone = true);
      }, name);
      let closed = false;
      while (Date.now() - started < 25 * 60 * 1000) {
        await new Promise(resolve => setTimeout(resolve, 15000));
        const state = await guest.evaluate(() => ({ done: longDone, state: renderStatusText.dataset.state, text: renderStatusText.textContent, rows: [...renderProgressDetails.children].map(row => row.children[1].textContent) }));
        console.log('Browser long', name, Math.round((Date.now() - started) / 1000), JSON.stringify(state));
        if (!closed) { await guest.evaluate(() => closeFilesModal()); closed = true; }
        if (state.done) { assert.equal(state.state, 'success', state.text); break; }
      }
      assert.equal(await guest.evaluate(() => longDone), true, 'Long browser export deadline');
      await waitUntil(() => fs.readdirSync(output).some(file => !previous.has(file) && file.endsWith('.mp4')) && !fs.readdirSync(output).some(file => file.endsWith('.crdownload')), 30000);
      const file = path.join(output, fs.readdirSync(output).find(file => !previous.has(file) && file.endsWith('.mp4')));
      const info = await require('../server/video-export-info').inspect(file);
      assert.ok(Math.abs(info.duration - scene.videoDuration) < .15);
      if (name !== 'custom') assert.equal(hash(file), sourceHash);
      ff(['-i', file, '-map', '0:a:0', '-f', 'null', '-']);
      results.push({ name, seconds: (Date.now() - started) / 1000, bytes: fs.statSync(file).size, duration: info.duration });
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    }
    assert.equal(await host.$('[data-operation=export]'), null);
    console.log('PASS long browser guest fast/repeat/custom, download and integrity', output);
  } finally { await browser?.close(); await server?.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
