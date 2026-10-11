const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');

test('audio extraction deduplicates active work and can rebuild a missing stream after completion', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-extraction-life-'));
  t.after(() => { assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  const input = path.join(directory, 'video.mp4');
  const generated = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', input], { windowsHide: true });
  assert.equal(generated.status, 0, String(generated.stderr));
  const context = { process, console, Buffer, setTimeout, clearTimeout, module: { exports: {} }, require(name) {
    if (name === './files') return { diskPathForUrl: url => path.join(directory, path.basename(url)) };
    if (name === './log') return { logEvent() {} };
    if (name === './config') return require('../server/config');
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync('server/media.js','utf8'), context);
  const { extractAudioTracks } = context.module.exports;
  const first = extractAudioTracks('/uploads/scene/video.mp4');
  assert.equal(extractAudioTracks('/uploads/scene/video.mp4'), first, 'parallel callers share one extraction job');
  const tracks = await first; assert.equal(tracks.length, 2);
  const files = tracks.map(track => path.join(directory,path.basename(track.url)));
  const bytes = files.map(file => fs.readFileSync(file));
  fs.unlinkSync(files[1]);
  const retry = extractAudioTracks('/uploads/scene/video.mp4'); await retry;
  for (let i=0; i<files.length; i++) assert.deepEqual(fs.readFileSync(files[i]),bytes[i]);
  assert.equal(vm.runInNewContext('audioTrackJobs.size',context),0,'completed jobs do not retain scene references');
  fs.unlinkSync(input); await assert.rejects(extractAudioTracks('/uploads/scene/video.mp4'), /unavailable/);
  assert.equal(vm.runInNewContext('audioTrackJobs.size',context),0,'failed jobs also release their entry');
});

test('rapid playback-source replacement keeps one metadata callback and preserves only the current scene position', async () => {
  const listeners = new Set();
  const video = { currentTime: 4, paused: false, src: 'initial', plays: 0,
    getAttribute() { return this.src; }, pause() { this.paused=true; },
    play() { this.plays++; this.paused=false; return Promise.resolve(); },
    addEventListener(name,callback) { assert.equal(name,'loadedmetadata'); listeners.add(callback); },
    removeEventListener(name,callback) { assert.equal(name,'loadedmetadata'); listeners.delete(callback); }
  };
  const context = { video, backing: {}, session: { activeSessionId:'scene',backingUrl:'' }, mediaUrl: url=>url, setMediaSource() {} };
  const source = fs.readFileSync('public/import.js','utf8');
  const start = source.indexOf('let restoreVideoMetadata') >= 0 ? source.indexOf('let restoreVideoMetadata') : source.indexOf('function swapVideoSource');
  vm.runInNewContext(source.slice(start,source.indexOf("localMediaInput.addEventListener('change'",start)),context);
  for (let i=0; i<40; i++) { video.paused=false; context.swapVideoSource('video-'+i); assert.equal(listeners.size,1); }
  video.currentTime=0;
  for (const callback of [...listeners]) { listeners.delete(callback); callback(); }
  assert.equal(video.currentTime,4); assert.equal(video.plays,1); assert.equal(listeners.size,0);
  context.swapVideoSource('next-video'); context.session.activeSessionId='other-scene'; video.currentTime=0;
  for (const callback of [...listeners]) { listeners.delete(callback); callback(); }
  assert.equal(video.currentTime,0); assert.equal(video.plays,1);
});
