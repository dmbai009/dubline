const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { io } = require('socket.io-client');
const { startServer, waitUntil } = require('../e2e/helpers');
const { inspectVideo, requiresCompatibleProxy } = require('../src/server/video-compatibility');
const { stageProjectDisk } = require('../src/server/project-archive');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('compatible working formats preserve supported AVC/AV1/VP9 and distinguish high-bit-depth AVC and incompatible audio', () => {
  const info = { codec: 'h264', profile: 'High', pixelFormat: 'yuv420p', audioCodecs: ['aac'] };
  assert.equal(requiresCompatibleProxy(info), false);
  for (const patch of [{ codec: 'mpeg4' }, { codec: 'hevc' }, { profile: 'High 10', pixelFormat: 'yuv420p10le' }, { pixelFormat: 'yuv444p' }, { audioCodecs: ['ac3'] }]) assert.equal(requiresCompatibleProxy({ ...info, ...patch }), true);
  for (const codec of ['av1', 'vp9']) assert.equal(requiresCompatibleProxy({ ...info, codec, pixelFormat: 'yuv420p10le' }), false);
});

test('real codec inspection, selective conversion, MIME/Range and protected original .dubline round-trip', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-codec-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const server = await startServer(); t.after(() => server.cleanup());
  const room = 'codec', clientId = crypto.randomUUID(), origin = `http://localhost:${server.port}`;
  const socket = io(origin, { transports: ['websocket'] }); t.after(() => socket.disconnect());
  let state; socket.on('session_updated', value => { state = value; });
  await new Promise(resolve => socket.once('connect', resolve)); socket.emit('join_room', { room, nick: 'Host', clientId });
  await waitUntil(() => state?.host === 'Host');
  for (const [name, codec, pixelFormat, audioCodec, copied] of [
    ['supported.mp4', 'libx264', 'yuv420p', 'aac', false],
    ['high10.mp4', 'libx264', 'yuv420p10le', 'aac', true],
    ['legacy.mkv', 'mpeg4', 'yuv420p', 'ac3', true]
  ]) {
    const file = path.join(dir, name);
    const ff = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=2',
      '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', codec, '-pix_fmt', pixelFormat, '-c:a', audioCodec, file], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(ff.status, 0, ff.stderr);
    const inspecting = inspectVideo(file); assert.equal(inspectVideo(file), inspecting, 'concurrent inspection reuses its FFmpeg job');
    const before = await inspecting; assert.equal(before.pixelFormat, pixelFormat);
    const form = new FormData(); form.append('clientId', clientId); form.append('video', new Blob([fs.readFileSync(file)]), name);
    const response = await fetch(`${origin}/api/upload-custom?room=${room}`, { method: 'POST', body: form });
    assert.equal(response.status, 200, await response.clone().text()); state = (await response.json()).session;
    assert.equal(state.hasOriginalVideo, copied);
    const range = await fetch(origin + state.videoUrl, { headers: { Range: 'bytes=0-1' } });
    assert.equal(range.status, 206); assert.match(range.headers.get('content-type'), /^video\/mp4/);
    assert.match(range.headers.get('content-range'), /^bytes 0-1\/\d+$/); assert.equal((await range.arrayBuffer()).byteLength, 2);
    const diagnosticUrl = `${origin}/api/video-diagnostics?room=${room}&sessionId=${state.activeSessionId}&clientId=`;
    assert.equal((await fetch(diagnosticUrl + 'unknown')).status, 403);
    const inspected = await fetch(diagnosticUrl + clientId); assert.equal(inspected.status, 200);
    const info = await inspected.json(); assert.equal(info.codec, 'h264'); assert.equal(info.pixelFormat, 'yuv420p'); assert.equal(info.requiresCompatibilityCopy, false); assert.equal(info.workingCopy, copied);
    const working = Buffer.from(await (await fetch(origin + state.videoUrl)).arrayBuffer());
    if (!copied) { assert.equal(hash(working), hash(fs.readFileSync(file)), 'compatible MP4 is not transcoded'); continue; }
    assert.equal((await fetch(origin + state.videoUrl.replace('dub_video.mp4', 'source_video' + path.extname(name)))).status, 403);
    const barrier = await new Promise(resolve => socket.emit('snapshot_request', { purpose: 'project', sessionId: state.activeSessionId }, resolve));
    const saved = await fetch(`${origin}/api/export-project?room=${room}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, clientId, sessionId: state.activeSessionId, download: true, barrierToken: barrier.token, forceSnapshot: true }) });
    assert.equal(saved.status, 200, await saved.clone().text());
    const archive = await fetch(origin + (await saved.json()).downloadUrl, { headers: { Cookie: 'dubline_client=' + clientId } });
    assert.equal(archive.status, 200);
    const project = path.join(dir, name + '.dubline'); fs.writeFileSync(project, Buffer.from(await archive.arrayBuffer()));
    const staged = await stageProjectDisk(project, dir);
    try {
      assert.equal(staged.fields.originalVideoName, name);
      assert.equal(hash(fs.readFileSync(staged.mediaFiles.find(value => value.video && !value.primary).path)), hash(fs.readFileSync(file)));
      assert.ok(Math.abs(require('../src/server/media').probeAudioDuration(staged.mediaFiles.find(value => value.primary).path) - 2) < .25);
    } finally { staged.rollback(); }
  }
});
