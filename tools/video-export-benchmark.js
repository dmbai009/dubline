// Reproducible synthetic 25-minute / 420-take pipeline comparison. Artifacts stay under audit/.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { startServer, launchBrowser, openPlayer, loadFixture, waitFor } = require('../e2e/helpers');
const root = path.join(__dirname, '..'), directory = path.join(root, 'audit', 'video-export');
fs.mkdirSync(directory, { recursive: true });
function ff(args) { const result = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true, timeout: 180000 }); assert.equal(result.status, 0, result.stderr); return result.stdout; }
async function run() {
  const movie = path.join(directory, 'benchmark-1500-720p.mp4');
  if (!fs.existsSync(movie)) ff(['-f', 'lavfi', '-i', 'color=black:size=1280x720:rate=25:duration=1500', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1500', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-shortest', movie]);
  const voiceRoot = process.argv[2], inputs = voiceRoot ? fs.readdirSync(path.join(voiceRoot, 'uploads')).filter(name => /^line_.*\.(wav|webm)$/.test(name)).slice(0, 3).map(name => path.join(voiceRoot, 'uploads', name)) : [];
  const voices = [0, 1, 2].map(index => {
    const file = path.join(directory, `voice-${index}.wav`);
    ff(inputs[index] ? ['-i', inputs[index], '-t', '2.5', '-ar', '48000', '-ac', '1', file] : ['-f', 'lavfi', '-i', `sine=frequency=${300 + index * 100}:duration=2.5`, '-ar', '48000', '-ac', '1', file]); return file;
  });
  const previous = spawnSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), 'show', '4d1be2c:public/export.js'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(previous.status, 0, previous.stderr);
  const baseline = previous.stdout.slice(previous.stdout.indexOf('async function renderWithWebCodecs('), previous.stdout.indexOf('// Fallback for browsers without WebCodecs')).replace('async function renderWithWebCodecs(', 'async function baselineVideoExport(');
  let server, browser;
  const results = [];
  try {
    server = await startServer(); browser = await launchBrowser(server.port);
    const seed = await openPlayer(browser, server.url('benchmark'), 'Benchmark host'); await loadFixture(seed);
    const videoUrl = await seed.evaluate(() => session.videoUrl), folder = path.join(server.dirs.uploads, path.dirname(videoUrl.slice('/uploads/'.length)));
    fs.copyFileSync(movie, path.join(server.dirs.uploads, videoUrl.slice('/uploads/'.length)));
    for (let index = 0; index < 420; index++) fs.copyFileSync(voices[index % 3], path.join(folder, `benchmark_${index}.wav`));
    await browser.close(); browser = null;
    for (const name of ['baseline', 'windowed', 'windowed-repeat']) {
      browser = await launchBrowser(server.port);
      const page = await openPlayer(browser, server.url('benchmark'), 'Benchmark actor'); await waitFor(page, () => video.duration === 1500);
      await page.evaluate(baseline + ';void 0;');
      await page.evaluate(({ videoUrl, name }) => {
        window.benchmarkPcmMaximum = 0;
        const Context = OfflineAudioContext;
        window.OfflineAudioContext = class extends Context { constructor(...args) { super(...args); benchmarkPcmMaximum = Math.max(benchmarkPcmMaximum, (typeof args[0] === 'number' ? args[1] * args[0] : args[0].length * args[0].numberOfChannels) * 4); } };
        const snapshot = createExportSnapshot(); snapshot.videoBlob = null; snapshot.backingUrl = null; snapshot.originalUrl = videoUrl;
        snapshot.scene.lines = Array.from({ length: 420 }, (_, index) => ({ ...session.lines[index % session.lines.length], id: index + 1, audioUrl: videoUrl.slice(0, videoUrl.lastIndexOf('/') + 1) + `benchmark_${index}.wav`, recordedBy: 'Actor ' + index % 10,
          start: index * 3.5, end: index * 3.5 + 2.5, audioStart: index * 3.5, recordedStart: index * 3.5, trimStart: 0, trimEnd: 2.5, trimEnabled: true,
          effect: ['none', 'telephone', 'radio', 'behindDoor'][index % 4], pitch: index % 3 - 1, effectAmount: 0.6, volume: 0.5 + index % 5 / 10, pan: (index % 3 - 1) * 0.3 }));
        snapshot.takes = snapshot.scene.lines; snapshot.gains = { ...snapshot.gains, original: 0.3, backing: 0, dub: 0.8 };
        snapshot.gains.mix.autoDuckEnabled = true; snapshot.gains.mix.autoDuckAmount = 0.5;
        window.benchmarkDone = false; window.benchmarkError = null; const started = performance.now();
        (name === 'baseline' ? baselineVideoExport(() => {}, snapshot) : renderWithWebCodecs(() => {}, snapshot)).then(blob => { window.benchmarkResult = { seconds: (performance.now() - started) / 1000, bytes: blob.size, pcmMaximum: benchmarkPcmMaximum }; window.benchmarkBlob = blob; benchmarkDone = true; }).catch(error => { benchmarkError = error.stack; benchmarkDone = true; });
      }, { videoUrl, name });
      const system = await browser.target().createCDPSession();
      let peak = 0, samples = 0;
      while (!await page.evaluate(() => benchmarkDone)) {
        const processes = (await system.send('SystemInfo.getProcessInfo')).processInfo;
        const ids = processes.map(process => process.id).filter(Number.isSafeInteger);
        const sampled = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum`], { encoding: 'utf8', windowsHide: true });
        peak = Math.max(peak, Number(sampled.stdout.trim()) || 0); samples++;
        await new Promise(resolve => setTimeout(resolve, 750));
      }
      assert.equal(await page.evaluate(() => benchmarkError), null);
      const result = await page.evaluate(() => benchmarkResult);
      const output = path.join(directory, `${name}.mp4`);
      await page.exposeFunction('benchmarkWrite', data => fs.appendFileSync(output, Buffer.from(data, 'base64')));
      fs.writeFileSync(output, '');
      await page.evaluate(async () => { for (let at = 0; at < benchmarkBlob.size; at += 1024 * 1024) { const bytes = new Uint8Array(await benchmarkBlob.slice(at, at + 1024 * 1024).arrayBuffer()); let text = ''; for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768)); await benchmarkWrite(btoa(text)); } });
      const info = await require('../src/server/video-export-info').inspect(output); assert.ok(Math.abs(info.duration - 1500) < 0.1);
      const hash = file => ff(['-i', file, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-']); assert.equal(hash(output), hash(movie));
      results.push({ name, ...result, peakBrowserWorkingSet: peak, samples, duration: info.duration }); console.log(JSON.stringify(results.at(-1)));
      await browser.close(); browser = null;
    }
    fs.writeFileSync(path.join(directory, 'benchmark-results.json'), JSON.stringify({ fixture: { duration: 1500, takes: 420, actorIdentities: 10, resolution: '1280x720', fps: 25, realVoiceSamples: inputs.length, snapshotOnly: true, browserOutputBuffered: true }, results }, null, 2));
  } finally { await browser?.close(); await server?.cleanup(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
