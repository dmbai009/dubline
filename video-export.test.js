const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const policy = require('./public/video-export-policy');
const { createVideoExportFiles, MAX_CHUNK } = require('./electron-video-export');
const info = { width: 1280, height: 720, duration: 1500, bitrate: 6000000, fps: 24 };
const options = { format: 'mp4', codec: 'avc', width: 1280, height: 720, bitrate: 6000000, fps: null };
test('custom bounds forbid upscaling either axis, video bitrate/FPS increases and unsupported codecs', () => {
  assert.equal(policy.validate(info, options), null);
  for (const change of [{ width: 1920, height: 1080 }, { width: 1282 }, { height: 722 }]) assert.equal(policy.validate(info, { ...options, ...change }), 'exportVideo.resolutionLimit');
  assert.equal(policy.validate(info, { ...options, bitrate: 6000001 }), 'exportVideo.bitrateLimit');
  assert.equal(policy.validate(info, { ...options, fps: 30 }), 'exportVideo.fpsLimit');
  assert.equal(policy.validate(info, { ...options, format: 'webm' }), 'exportVideo.unsupported');
});
test('unknown source values stay unknown; estimates use video-stream bitrate rather than container bytes', () => {
  assert.equal(policy.validate({ ...info, bitrate: null }, options), 'exportVideo.unknownBounds');
  assert.equal(policy.estimate({ ...info, bitrate: null, fileSize: 2000000000 }), null);
  assert.equal(policy.estimate(info), Math.ceil(1500 * 6192000 / 8 * 1.02));
  assert.equal(policy.estimate(info, { mode: 'custom', bitrate: 3000000 }), Math.ceil(1500 * 3192000 / 8 * 1.02));
  assert.equal(policy.validate({ ...info, fps: null }, { ...options, fps: 24 }), 'exportVideo.fpsLimit');
});
test('portrait and nonstandard resolutions keep aspect ratio and never increase either dimension', () => {
  for (const source of [info, { width: 720, height: 1280 }, { width: 1000, height: 421 }]) {
    const smaller = policy.dimensions(source, 360);
    assert.ok(smaller.width <= source.width && smaller.height <= source.height);
    assert.ok(Math.abs(smaller.width / smaller.height - source.width / source.height) <= 2 / smaller.height);
  }
});
async function fixture(t, config = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-video-export-')), destination = path.join(directory, 'export.mp4');
  if (config.existing) fs.writeFileSync(destination, config.existing);
  const files = createVideoExportFiles({ choose: async () => ({ filePath: destination }), freeSpace: async () => 10 * 1024 ** 3, ...config });
  t.after(async () => { await files.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const selected = await files.chooseDestination('owner', { extension: 'mp4', sessionId: 'scene', estimatedBytes: 100, title: 'Scene' });
  return { files, directory, destination, selected, request: { ticket: selected.ticket, sessionId: 'scene' } };
}
test('save dialog cancellation creates no output or temporary file', async t => {
  const f = await fixture(t, { choose: async () => ({ canceled: true }) });
  assert.deepEqual(f.selected, { ok: true, canceled: true }); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('a CPU retry resets only its owned temporary output and commits no stale GPU tail', async t => {
  const f = await fixture(t, { existing: 'previous saved export' });
  await f.files.write('owner', { ...f.request, position: 0, bytes: Uint8Array.of(1, 2, 3, 4, 5, 6) });
  assert.equal((await f.files.reset('other', f.request)).ok, false);
  assert.equal((await f.files.reset('owner', { ...f.request, sessionId: 'other' })).ok, false);
  assert.equal((await f.files.reset('owner', f.request)).ok, true);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'previous saved export');
  await f.files.write('owner', { ...f.request, position: 0, bytes: Uint8Array.of(7, 8) });
  assert.equal((await f.files.commit('owner', { ...f.request, bytes: 2 })).ok, true);
  assert.deepEqual([...fs.readFileSync(f.destination)], [7, 8]);
  assert.equal((await f.files.reset('owner', f.request)).ok, false);
  assert.deepEqual([...fs.readFileSync(f.destination)], [7, 8]);
});
test('streamed random-access writes commit exact bytes and reveal only an owned saved destination', async t => {
  const f = await fixture(t);
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal((await f.files.write('other', { ...f.request, position: 0, bytes: Uint8Array.of(9) })).ok, false);
  for (const [position, bytes] of [[0, [0, 0, 0, 0]], [4, [5, 6]], [0, [1, 2, 3, 4]]]) assert.equal((await f.files.write('owner', { ...f.request, position, bytes: Uint8Array.from(bytes) })).ok, true);
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal((await f.files.commit('owner', { ...f.request, bytes: 6 })).ok, true);
  assert.deepEqual([...fs.readFileSync(f.destination)], [1, 2, 3, 4, 5, 6]);
  assert.equal(f.files.revealed('owner', f.request), f.destination);
  assert.throws(() => f.files.revealed('other', f.request));
});
test('cancel and rejected sparse output preserve an existing destination and remove temporary data', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.destination, 'previous');
  assert.equal((await f.files.write('owner', { ...f.request, position: 5, bytes: Uint8Array.of(1) })).ok, true);
  assert.equal((await f.files.commit('owner', { ...f.request, bytes: 6 })).ok, false);
  await f.files.cancel('owner', f.request);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'previous'); assert.deepEqual(fs.readdirSync(f.directory), ['export.mp4']);
});
test('another application changing the chosen destination prevents replacement', async t => {
  const f = await fixture(t);
  await f.files.write('owner', { ...f.request, position: 0, bytes: Uint8Array.of(1, 2) });
  fs.writeFileSync(f.destination, 'keep me');
  assert.equal((await f.files.commit('owner', { ...f.request, bytes: 2 })).key, 'exportVideo.destinationChanged');
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'keep me'); assert.deepEqual(fs.readdirSync(f.directory), ['export.mp4']);
});
test('disk space refusal and excessive IPC chunks fail before final output is created', async t => {
  const f = await fixture(t, { freeSpace: async () => 0 });
  assert.equal(f.selected.key, 'project.diskSpace'); assert.deepEqual(fs.readdirSync(f.directory), []);
  const other = await fixture(t);
  assert.equal((await other.files.write('owner', { ...other.request, position: 0, bytes: new Uint8Array(MAX_CHUNK + 1) })).ok, false);
  assert.equal((await other.files.write('owner', { ...other.request, sessionId: 'other', position: 0, bytes: Uint8Array.of(1) })).ok, false);
  assert.deepEqual(fs.readdirSync(other.directory), []);
});
test('window/navigation cleanup cancels only its own file and allows repeated completed exports', async t => {
  const f = await fixture(t);
  await f.files.write('owner', { ...f.request, position: 0, bytes: Uint8Array.of(1) });
  await f.files.releaseOwner('unrelated'); assert.equal(fs.readdirSync(f.directory).length, 1);
  await f.files.releaseOwner('owner'); assert.deepEqual(fs.readdirSync(f.directory), []);
  for (let i = 0; i < 6; i++) {
    const choice = await f.files.chooseDestination('owner', { extension: 'mp4', sessionId: 'scene' });
    assert.equal(choice.ok, true);
    await f.files.write('owner', { ticket: choice.ticket, sessionId: 'scene', position: 0, bytes: Uint8Array.of(i) });
    assert.equal((await f.files.commit('owner', { ticket: choice.ticket, sessionId: 'scene', bytes: 1 })).ok, true);
  }
});

test('host and guest preloads bound bytes before IPC and strip paths and unrelated payloads', async () => {
  const vm = require('node:vm');
  for (const filename of ['electron-preload.js', 'electron-guest-preload.js']) {
    const bridges = {}, calls = [];
    const electron = { contextBridge: { exposeInMainWorld: (name, api) => { bridges[name] = api; } }, ipcRenderer: { sendSync: () => 'en', invoke: async (channel, data) => { calls.push({ channel, data }); return { ok: true }; } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, filename), 'utf8'), { require: () => electron, process: { isMainFrame: true }, Uint8Array });
    const api = bridges.dublineVideoExport, buffer = new Uint8Array(4 * MAX_CHUNK);
    await api.write({ ticket: 't', sessionId: 'scene', position: 0, bytes: buffer.subarray(0, 3), path: 'private', unrelated: buffer });
    assert.equal(calls.length, 1); assert.equal(calls[0].data.bytes.buffer.byteLength, 3);
    assert.deepEqual(Object.keys(calls[0].data).sort(), ['bytes', 'position', 'sessionId', 'ticket']);
    assert.equal((await api.write({ position: 0, bytes: buffer })).ok, false); assert.equal(calls.length, 1);
    await api.choose({ extension: 'mp4', sessionId: 'scene', title: 'x'.repeat(1000), path: 'arbitrary' });
    assert.equal(calls[1].data.title.length, 100); assert.equal(calls[1].data.path, undefined);
    if (filename.includes('guest')) assert.equal(bridges.dublineDesktop, undefined);
  }
});

test('normalized extension requires explicit overwrite consent and unsafe destinations are refused', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-video-picker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const selected = path.join(directory, 'movie'), destination = selected + '.mp4'; fs.writeFileSync(destination, 'keep');
  let asked = 0;
  const files = createVideoExportFiles({ choose: async () => ({ filePath: selected }), confirmOverwrite: async () => { asked++; return false; } });
  const request = { extension: 'mp4', sessionId: 'scene' };
  assert.equal((await files.chooseDestination('owner', request)).canceled, true); assert.equal(asked, 1);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'keep');
  const blocked = createVideoExportFiles({ choose: async () => ({ filePath: selected }), allowedDestination: async () => false });
  assert.equal((await blocked.chooseDestination('owner', request)).ok, false);
  assert.equal((await blocked.chooseDestination('owner', { ...request, estimatedBytes: 65 * 1024 ** 3 })).ok, false);
  await files.close(); await blocked.close();
});

test('concurrent IPC writes are rejected without unlocking the first writer; commit has one atomic boundary', async t => {
  const f = await fixture(t);
  const writing = f.files.write('owner', { ...f.request, position: 0, bytes: Uint8Array.of(1, 2, 3) });
  assert.equal((await f.files.write('owner', { ...f.request, position: 0, bytes: Uint8Array.of(9) })).key, 'project.busy');
  assert.equal((await writing).ok, true);
  const committing = f.files.commit('owner', { ...f.request, bytes: 3 });
  assert.equal((await f.files.cancel('owner', f.request)).key, 'exportVideo.committing');
  assert.equal((await committing).ok, true); assert.deepEqual([...fs.readFileSync(f.destination)], [1, 2, 3]);
});

test('disk exhaustion while writing leaves the old destination and removes the partial file', async t => {
  const f = await fixture(t), open = fs.promises.open;
  fs.writeFileSync(f.destination, 'keep');
  fs.promises.open = async (...args) => { const file = await open(...args); file.write = async () => { throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); }; return file; };
  t.after(() => { fs.promises.open = open; });
  const response = await f.files.write('owner', { ...f.request, position: 0, bytes: Uint8Array.of(1) });
  assert.equal(response.key, 'project.diskSpace'); await f.files.cancel('owner', f.request);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'keep'); assert.deepEqual(fs.readdirSync(f.directory), ['export.mp4']);
});

function controlledAudio() {
  const requests = [], buffer = { duration: 2, length: 96000, numberOfChannels: 1 };
  const window = { DublineTakeMix: require('./public/take-mix'), DublineAudioFx: {
    effectTailSeconds: () => 0, renderVoice: async data => data,
    fetchAndDecode: (_url, { signal } = {}) => new Promise((resolve, reject) => {
      const request = { resolve: () => resolve(buffer), aborted: false }; requests.push(request);
      const abort = () => { request.aborted = true; reject(new DOMException('Cancelled', 'AbortError')); };
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    })
  } };
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, 'public/audio.js'), 'utf8'), { window, AbortController, console, setTimeout, clearTimeout });
  const controller = window.DublineAudio.createController({ video: {}, backing: {}, getSession: () => ({ lines: [] }), getVolumes: () => ({}), getSettings: () => ({}), isRenderInProgress: () => false, getRecordingLineId: () => null });
  return { controller, requests, buffer };
}
test('cancelled export aborts its own take fetch and permits a clean retry', async () => {
  const { controller, requests, buffer } = controlledAudio(), abort = new AbortController();
  const first = controller.getProcessedTake({ audioUrl: 'take' }, { signal: abort.signal }); await Promise.resolve();
  abort.abort(); assert.equal(await first, null); assert.equal(requests[0].aborted, true);
  const retry = controller.getRawTake('take'); await Promise.resolve(); requests[1].resolve(); assert.equal(await retry, buffer);
});
test('export cancellation leaves a take fetch needed by ordinary playback intact, including processed-cache hits', async () => {
  const { controller, requests, buffer } = controlledAudio(), abort = new AbortController(), line = { audioUrl: 'take' };
  const exporting = controller.getProcessedTake(line, { signal: abort.signal }); await Promise.resolve();
  const playback = controller.getProcessedTake(line); abort.abort(); assert.equal(requests[0].aborted, false);
  requests[0].resolve(); assert.equal(await exporting, buffer); assert.equal(await playback, buffer); assert.equal(requests.length, 1);
});

test('an abandoned native destination expires, closes its writer and preserves the existing file', async t => {
  const f = await fixture(t, { ttlMs: 100 }); fs.writeFileSync(f.destination, 'KEEP');
  await f.files.write('owner', { ...f.request, position: 0, bytes: Uint8Array.of(1) });
  const deadline = Date.now() + 2000;
  while ((f.files.busy || fs.readdirSync(f.directory).some(name => name.endsWith('.part'))) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.files.busy, false); assert.deepEqual(fs.readdirSync(f.directory), ['export.mp4']); assert.equal(fs.readFileSync(f.destination, 'utf8'), 'KEEP');
});
