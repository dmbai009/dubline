const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('./public/project-audio');
const adr = require('./public/adr-cues');

test('portable builds use per-launch extraction with the installed packager', () => {
  const options = require('./package.json').build.portable;
  // The installed builder's implementation differs from its unpackDirName docs:
  // false still sets a build-wide directory; true leaves NSIS $PLUGINSDIR in use.
  const source = fs.readFileSync('node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js', 'utf8');
  const begin = source.indexOf('const { unpackDirName, requestExecutionLevel, splashImage } = options;');
  const end = source.indexOf('if (splashImage != null)', begin);
  assert.ok(begin >= 0 && end > begin, 'Review portable extraction semantics after upgrading electron-builder');
  const context = { options, defines: {}, builder_util_1: { generateKsuid: () => 'shared-build-directory' } };
  vm.runInNewContext(source.slice(begin, end), context);
  assert.equal(Object.hasOwn(context.defines, 'UNPACK_DIR_NAME'), false, 'Concurrent launches must not delete one another\'s resources');
});

function audioController(fx) {
  const context = { window: { DublineAudioFx: fx, DublineTakeMix: require('./public/take-mix') }, console: { error() {} }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync('public/audio.js', 'utf8'), context);
  return context.window.DublineAudio.createController({ getSession: () => null, getLatency: () => 0 });
}

test('take caches deduplicate in-flight jobs but retry failed downloads and processing', async () => {
  let downloads = 0, processing = 0;
  const buffer = { duration: 1 };
  const fx = { fetchAndDecode: async () => { if (++downloads === 1) throw new Error('offline'); return buffer; },
    renderVoice: async b => { if (++processing === 1) throw new Error('decode'); return b; } };
  const audio = audioController(fx), line = { audioUrl: '/take' };
  assert.equal(await audio.getProcessedTake(line), null);
  assert.equal(await audio.getProcessedTake(line), null);
  const [one, two] = await Promise.all([audio.getProcessedTake(line), audio.getProcessedTake(line)]);
  assert.equal(one, buffer); assert.equal(two, buffer);
  assert.equal(downloads, 2); assert.equal(processing, 2);
  assert.equal(await audio.getProcessedTake(line), buffer);
  assert.equal(downloads, 2); assert.equal(processing, 2);
});

function exportContext() {
  class Offline {
    constructor() { this.sources = []; this.destination = {}; }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect: target => target }; }
    createDynamicsCompressor() { return { threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect() {} }; }
    createBufferSource() {
      const node = { connect(level) { node.level = level; return level; }, start(when, from, duration) { Object.assign(node, { when, from, duration }); } };
      this.sources.push(node); return node;
    }
    async startRendering() { return this.sources; }
  }
  const context = { structuredClone, OfflineAudioContext: Offline, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { getElementById: () => ({ style: {} }) }, video: { addEventListener() {} },
    session: { activeSessionId: 'one', videoUrl: '/video', backingUrl: '/backing', title: 'First', lines: [], latency: { Alice: 0 } },
    localMedia: null, mediaUrl: url => url, canHearLine: () => true,
    DublineTakeMix: require('./public/take-mix'),
    DublineAudioFx: { connectTake(ctx, source, destination, line) { source.clipMix = require('./public/take-mix').normalize(line); source.connect(destination); } },
    t: (key, args) => `${key}:${args?.source || ''}`, DublineProjectAudio: model,
    takeBounds: (line, duration) => ({ from: 0, to: duration }), getProcessedTake: async () => ({ duration: 1 }) };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('public/export.js', 'utf8'), context);
  return context;
}

test('all stems keep the same captured gain, timing and take fields across asynchronous changes', async () => {
  const c = exportContext();
  c.session.projectAudio = { dub: { volume: 0.25 } };
  const lines = [{ id: 1, audioUrl: '/take', audioStart: 3, recordedBy: 'Alice' }];
  c.session.lines = lines;
  const snapshot = c.createExportSnapshot();
  let release;
  c.getProcessedTake = () => new Promise(resolve => { release = resolve; });
  const rendering = c.renderCharacterStem(lines, 5, 48000, snapshot);
  c.session.latency.Alice = 1000; c.session.projectAudio.dub.volume = 0.9; lines[0].audioStart = 0;
  release({ duration: 1 });
  const [source] = await rendering;
  assert.equal(source.when, 3); assert.equal(source.level.gain.value, 0.25);
  c.getProcessedTake = async () => ({ duration: 1 });
  const [next] = await c.renderCharacterStem(snapshot.takes, 5, 48000, snapshot);
  assert.equal(next.when, 3); assert.equal(next.level.gain.value, 0.25);
  assert.equal(snapshot.scene.title, 'First');
});

test('exports retry a take once then fail explicitly instead of producing an incomplete file', async () => {
  const c = exportContext(), line = { id: 7, audioUrl: '/take', start: 0 };
  c.session.lines = [line]; c.session.projectAudio = { dub: { solo: true } };
  let calls = 0;
  c.getProcessedTake = async () => { calls++; return null; };
  await assert.rejects(c.mixSoundtrack(2, c.readRenderGains(), () => {}), error => error.code === 'DUBLINE_EXPORT_AUDIO' && error.message.includes('#7'));
  assert.equal(calls, 2);
  c.session.projectAudio.dub.muted = true;
  await c.mixSoundtrack(2, c.readRenderGains(), () => {});
  assert.equal(calls, 2, 'muted channels do not need their audio downloaded');
});

test('source decode errors never imply silence; only successfully probed silent video omits Original', async () => {
  const c = exportContext();
  c.fetchAndDecode = async () => { throw new Error('HTTP 503'); };
  await assert.rejects(c.decodeExportSource('/video', 'Original'), error => error.code === 'DUBLINE_EXPORT_AUDIO');
  c.fetchAndDecode = async () => { const error = new Error('No audio'); error.name = 'EncodingError'; throw error; };
  await assert.rejects(c.decodeExportSource('/video', 'Original'), error => error.code === 'DUBLINE_EXPORT_AUDIO');
  await assert.rejects(c.decodeExportSource('/external', 'Original'), error => error.code === 'DUBLINE_EXPORT_AUDIO');
  c.session.videoHasAudio = false; c.session.backingUrl = '';
  assert.equal((await c.mixSoundtrack(1, c.readRenderGains(), () => {})).length, 0);
});

test('single converted video tracks are selected, while legacy unknown empty arrays remain unknown', () => {
  const scene = { videoUrl: '/video', videoHasAudio: true, audioTracks: [{ url: '/aac' }] };
  assert.equal(model.sources(scene).original, '/aac');
  assert.equal(model.sources({ ...scene, originalTrack: -1 }).original, '');
  assert.equal(model.sources({ ...scene, videoHasAudio: false }).original, '');
  assert.equal(model.sources({ ...scene, videoHasAudio: false, externalOriginalUrl: '/external' }).original, '/external');
  assert.equal(model.sources({ videoUrl: '/legacy', audioTracks: [] }).original, '/legacy');
});

test('pending export playback is time-bounded and a late resolution cannot restart export', async () => {
  const c = exportContext(); let release, paused = 0;
  c.video.play = () => new Promise(resolve => { release = resolve; });
  c.video.pause = () => { paused++; };
  await assert.rejects(c.waitForRenderPlayback(c.createExportSnapshot(), 20), error => error.code === 'DUBLINE_EXPORT_PLAYBACK');
  assert.equal(paused, 1); release(); await Promise.resolve(); assert.equal(paused, 1);
});

test('changing scene aborts a still-pending play promise instead of waiting forever', async () => {
  const c = exportContext(); c.video.play = () => new Promise(() => {}); c.video.pause = () => {};
  const task = c.waitForRenderPlayback(c.createExportSnapshot(), 5000);
  c.session.activeSessionId = 'two';
  await assert.rejects(task, error => error.code === 'DUBLINE_EXPORT_SCENE');
});

test('session changes invalidate a video export snapshot rather than mixing two scenes', () => {
  const c = exportContext(), snapshot = c.createExportSnapshot();
  c.assertExportScene(snapshot);
  c.session.activeSessionId = 'two';
  assert.throws(() => c.assertExportScene(snapshot), error => error.code === 'DUBLINE_EXPORT_SCENE');
});

test('cancelling ADR before AudioContext resumes cannot start delayed beeps', async () => {
  let resume, starts = 0;
  class Context {
    constructor() { this.state = 'suspended'; }
    resume() { return new Promise(resolve => { resume = resolve; }); }
    createOscillator() { starts++; throw new Error('must not create cancelled cues'); }
  }
  const cues = adr.create(Context);
  cues.arm(3); cues.stop(); resume(); await Promise.resolve();
  assert.equal(starts, 0);
});

test('guest preload exposes only language preferences, with no bridge in subframes', () => {
  for (const isMainFrame of [true, false]) {
    let exposed;
    vm.runInNewContext(fs.readFileSync('electron-guest-preload.js', 'utf8'), {
      process: { isMainFrame }, require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed = { name, value }; } },
        ipcRenderer: { sendSync: channel => { assert.equal(channel, 'app:get-language'); return 'uk'; }, invoke: async () => true } })
    });
    if (!isMainFrame) assert.equal(exposed, undefined);
    else { assert.equal(exposed.name, 'dublinePreferences'); assert.deepEqual(Object.keys(exposed.value).sort(), ['language', 'setLanguage']); assert.equal(exposed.value.language, 'uk'); }
  }
});

test('guest language IPC accepts only the configured origin and the main frame', () => {
  const source = fs.readFileSync('electron-main.js', 'utf8');
  const begin = source.indexOf('function isGuestLanguageSender('), end = source.indexOf("ipcMain.handle('launcher:detect-tools'", begin);
  const frame = { url: 'http://localhost:38500/?room=main' }, webContents = { mainFrame: frame };
  const c = { guestOrigin: 'http://localhost:38500', mainWindow: { isDestroyed: () => false, webContents }, URL };
  vm.runInNewContext(source.slice(begin, end), c);
  assert.equal(c.isGuestLanguageSender({ sender: webContents, senderFrame: frame }), true);
  assert.equal(c.isGuestLanguageSender({ sender: webContents, senderFrame: { url: frame.url } }), false);
  frame.url = 'https://another.example';
  assert.equal(c.isGuestLanguageSender({ sender: webContents, senderFrame: frame }), false);
});

test('guest language follows app preference across fresh origins without enabling host UI', () => {
  let saved = 'uk';
  const source = fs.readFileSync('public/i18n.js', 'utf8');
  const open = () => {
    const values = new Map();
    const c = { window: { dublinePreferences: { language: saved, setLanguage: async code => { saved = code; } }, dispatchEvent() {} },
      document: { documentElement: {}, querySelectorAll: () => [] }, CustomEvent: function() {},
      localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) } };
    vm.runInNewContext(source, c); return c.window;
  };
  const first = open(); assert.equal(first.DublineI18n.getLanguage(), 'uk'); assert.equal(first.dublineDesktop, undefined);
  first.DublineI18n.setLanguage('ru');
  assert.equal(open().DublineI18n.getLanguage(), 'ru');
});
