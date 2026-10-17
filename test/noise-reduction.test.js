const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const model = require('../src/public/noise-model'), noise = require('../src/server/noiseReduction'), legacy = require('../src/server/noiseLegacy');
const history = require('../src/public/take-history-model'), voice = require('../src/public/voice-chain-model');
const { captureProject, validateManifest, stageProject, exportProject } = require('../src/server/projects');
const profile = () => ({ id: 'old-profile', author: 'Actor', version: 1, fft: 1024, sampleRate: 48000, createdAt: 1, power: Array(513).fill(.01) });
const legacyState = () => ({ profiles: { 'old-profile': profile() }, actors: { Actor: { enabled: true, strength: .2, profileId: 'old-profile' } }, revision: 4 });
const request = (revision, actor = { enabled: true, strength: .6 }) => ({ ...model.protocol(), revision, actor });
function scene() {
  const s = { activeSessionId: 'scene', noiseReduction: noise.empty(), lines: [], roleEffects: {} };
  s.noiseReduction.actors.Actor = { enabled: true, strength: .6 }; s.noiseReduction.revision = 1;
  s.lines = [{ id: 1, character: 'Role', takeId: 'main-a', audioUrl: 'main.webm', recordedBy: 'Actor', effect: 'telephone', pitch: 3, volume: .7, pan: -.2,
    takeHistoryRevision: 2, takeHistory: [{ ...history.DEFAULTS, id: 'old-a', recordedBy: 'Actor', audioUrl: 'old.webm', pinned: true }] },
    { id: 2, character: 'Other', takeId: 'main-b', audioUrl: 'other.webm', recordedBy: 'Other', takeHistory: [] }];
  return s;
}
test('author settings are atomic, scene-revision-bound and independent of take/role ownership', () => {
  const s = scene(), before = structuredClone(s), next = noise.plan(s, 'Actor', request(1, { enabled: true, strength: .25 }));
  assert.deepEqual(structuredClone(s), before); assert.equal(next.state.actors.Actor.strength, .25); assert.equal(next.state.revision, 2);
  assert.equal(model.resolve(s.lines[0], { noiseReduction: next.state }).strength, .25);
  assert.equal(model.resolve(s.lines[0].takeHistory[0], { noiseReduction: next.state }).strength, .25);
  assert.equal(model.resolve(s.lines[1], { noiseReduction: next.state }), null);
  assert.throws(() => noise.plan(s, 'Actor', request(0)), /conflict/);
  assert.throws(() => noise.plan(s, 'Other', { ...request(1), author: 'Actor' }), /invalid/);
  assert.throws(() => noise.plan(s, 'Other', request(1, { enabled: true, strength: .7, name: 'Actor' })), /invalid/);
});
test('disabled and zero strength bypass; enabling retains strength; unchanged updates do not advance revisions', () => {
  const s = scene(); s.noiseReduction = noise.plan(s, 'Actor', request(1, { enabled: false, strength: .75 })).state;
  assert.equal(model.resolve(s.lines[0], s), null);
  assert.equal(noise.plan(s, 'Actor', request(2, { enabled: false, strength: .75 })).changed, false);
  s.noiseReduction = noise.plan(s, 'Actor', request(2, { enabled: true, strength: .75 })).state;
  assert.equal(model.resolve(s.lines[0], s).strength, .75);
  s.noiseReduction = noise.plan(s, 'Actor', request(3, { enabled: true, strength: 0 })).state;
  assert.equal(model.resolve(s.lines[0], s), null);
  assert.deepEqual(model.actor(s.noiseReduction, 'New'), { enabled: false, strength: .6 });
});
test('new schema rejects unsupported engines, versions, profiles, malformed actors and excessive state', () => {
  assert.equal(model.validState(scene().noiseReduction), true);
  for (const bad of [{ engine: 'wiener' }, { engineVersion: 'next' }, { modelVersion: 'other' }, { schemaVersion: 99 }, { dspVersion: 99 }, { profiles: {} }])
    assert.equal(model.validState({ ...scene().noiseReduction, ...bad }), false);
  for (const strength of [-.1, 1.1, Infinity, NaN, '0.6']) assert.throws(() => noise.plan(scene(), 'Actor', request(1, { enabled: true, strength })), /invalid/);
  for (const fields of [{ profile: profile() }, { takes: [] }, { profileId: 'old-profile' }, { initialize: true }]) assert.throws(() => noise.plan(scene(), 'Actor', { ...request(1), ...fields }), /invalid/);
  const s = noise.empty(); for (let i = 0; i < 2001; i++) s.actors['actor' + i] = { enabled: false, strength: .6 };
  assert.equal(model.validState(s), false);
});
test('legacy migration removes bindings from current/history/trash and never copies Wiener intensity', () => {
  const s = scene(); s.noiseReduction = legacyState(); s.lines[0].noiseProfileId = 'old-profile'; s.lines[0].takeHistory[0].noiseProfileId = 'old-profile';
  s.deletedLines = [{ lines: [{ line: { ...structuredClone(s.lines[0]), id: 99 } }] }];
  const original = structuredClone(s.lines), originalTrash = structuredClone(s.deletedLines);
  assert.equal(legacy.validState(s.noiseReduction), true); assert.equal(model.migrateScene(s), true);
  assert.deepEqual(s.noiseReduction.actors.Actor, { enabled: false, strength: .6 }); assert.equal(model.validState(s.noiseReduction), true);
  assert.equal(JSON.stringify(s).includes('noiseProfileId'), false); assert.equal(JSON.stringify(s.noiseReduction).includes('profiles'), false);
  for (const line of original) { delete line.noiseProfileId; for (const take of line.takeHistory) delete take.noiseProfileId; }
  for (const entry of originalTrash[0].lines) { delete entry.line.noiseProfileId; for (const take of entry.line.takeHistory) delete take.noiseProfileId; }
  assert.deepEqual(s.lines, original); assert.deepEqual(s.deletedLines, originalTrash); assert.equal(model.migrateScene(s), false);
});
test('nickname migration retains author settings; history preserves authors without profile bindings', () => {
  const s = scene(); noise.rename(s, 'Actor', 'Renamed'); assert.equal(s.noiseReduction.actors.Renamed.strength, .6); assert.equal(Object.hasOwn(s.noiseReduction.actors, 'Actor'), false);
  const take = history.extract(s.lines[0]), restored = {}; history.activate(restored, take);
  assert.equal(restored.recordedBy, 'Actor'); assert.equal(Object.hasOwn(restored, 'noiseProfileId'), false);
  assert.equal(Object.hasOwn(require('../src/server/parsers').emptyTake(), 'noiseProfileId'), false);
});
class BufferPCM {
  constructor({ length = 64, numberOfChannels = 1, sampleRate = 48000 } = {}) { this.length = length; this.numberOfChannels = numberOfChannels; this.sampleRate = sampleRate; this.duration = length / sampleRate; this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length)); }
  getChannelData(c) { return this.channels[c]; }
  copyToChannel(pcm, c) { this.channels[c].set(pcm); }
}
function audioHarness(state, fetch) {
  const global = { addEventListener() {}, DublineNoiseModel: model, DublineTakeMix: require('../src/public/take-mix'), DublineAudioMemory: require('../src/public/audio-memory'), DublineVoiceChain: voice };
  const context = { window: global, AudioBuffer: BufferPCM, AbortController, DOMException, setTimeout, clearTimeout, performance, console, Audio: function() {} };
  vm.runInNewContext(fs.readFileSync('src/public/noise-audio.js', 'utf8'), context);
  let computations = 0, fail = false; const raw = new BufferPCM(); raw.channels[0].fill(.2);
  global.DublineNoiseAudio = { ...global.DublineNoiseAudio, wet: async buffer => { computations++; if (fail) throw Error('noise.unavailable'); const wet = new BufferPCM(buffer); wet.channels[0].set(buffer.channels[0].map(x => x / 2)); return wet; } };
  const effects = [];
  global.DublineAudioFx = { fetchAndDecode: fetch || (async () => raw), renderChain: async (buffer, config) => { effects.push({ buffer, config }); return buffer; }, effectTailSeconds: () => 0 };
  vm.runInNewContext(fs.readFileSync('src/public/audio.js', 'utf8'), context);
  const controller = global.DublineAudio.createController({ video: { paused: true }, backing: {}, getSession: () => state, getVolumes: () => ({}), getSettings: () => ({}), isRenderInProgress: () => false, getRecordingLineId: () => null });
  return { controller, global, raw, effects, computations: () => computations, fail: value => { fail = value; } };
}
test('Wet is reused across strength, trim and role/take effects; only final mixes depend on those settings', async () => {
  const state = scene(), h = audioHarness(state), take = state.lines[0];
  const first = await h.controller.getProcessedTake(take); assert.equal(await h.controller.getProcessedTake(take), first); assert.equal(h.computations(), 1);
  const snapshot = { ...take, _exportNoise: model.resolve(take, state), _exportVoice: voice.resolve(take, state) };
  state.noiseReduction.actors.Actor.strength = .25; h.controller.invalidateNoise('Actor');
  const next = await h.controller.getProcessedTake(take); assert.ok(Math.abs(next.channels[0][0] - .175) < 1e-7); assert.equal(h.computations(), 1);
  take.pitch = -2; take.trimStart = 0; take.trimEnd = .001; await h.controller.getProcessedTake(take); assert.equal(h.computations(), 1);
  state.roleEffects.Role = { pitch: 2, effects: [], revision: 1 }; h.controller.invalidateRole('Role'); await h.controller.getProcessedTake(take); assert.equal(h.computations(), 1);
  assert.ok(Math.abs((await h.controller.getProcessedTake(snapshot, { scene: structuredClone(state) })).channels[0][0] - .14) < 1e-7);
  assert.equal(h.controller.cacheStats().processed.limit, 256 * 1024 ** 2); assert.equal(h.controller.cacheStats().noise.wetEntries, 1);
  state.noiseReduction.actors.Actor.enabled = false; h.controller.invalidateNoise('Actor'); assert.equal(await h.controller.getProcessedTake(take), h.raw); assert.equal(h.computations(), 1);
});
test('zero strength does not run the engine; fallback is retryable and never cached as Wet or a successful final result', async () => {
  const state = scene(), h = audioHarness(state), take = state.lines[0]; state.noiseReduction.actors.Actor.strength = 0;
  assert.equal(await h.controller.getProcessedTake(take), h.raw); assert.equal(h.computations(), 0);
  state.noiseReduction.actors.Actor.strength = .6; h.fail(true); assert.equal(await h.controller.getProcessedTake(take), h.raw);
  assert.equal(h.controller.cacheStats().noise.wetEntries, 0); h.fail(false);
  assert.notEqual(await h.controller.getProcessedTake(take), h.raw); assert.equal(h.computations(), 2);
});
test('concurrent mixes share one Wet task; replacement identity gets a new Wet result', async () => {
  const state = scene(), h = audioHarness(state), take = state.lines[0];
  await Promise.all([.25, .5, .75].map(strength => h.controller.getProcessedTake({ ...take, _exportNoise: { ...model.protocol(), enabled: true, strength } })));
  assert.equal(h.computations(), 1); const before = { ...take }; take.audioUrl = 'replacement.webm'; h.controller.updateLine(before, take);
  await h.controller.getProcessedTake(take); assert.equal(h.computations(), 2); assert.equal(h.controller.cacheStats().noise.wetEntries, 1);
});

test('a strict export sharing playback refuses neural fallback and shares successful retries', async () => {
  const state = scene(), h = audioHarness(state), take = state.lines[0]; h.fail(true);
  const playback = h.controller.getProcessedTake(take), exported = h.controller.getProcessedTake(take, { strict: true });
  assert.equal(await playback, h.raw); assert.equal(await exported, null); assert.equal(h.computations(), 1);
  assert.equal(h.controller.cacheStats().noise.wetEntries, 0);
  h.fail(false);
  const exportRetry = h.controller.getProcessedTake(take, { strict: true }), playbackRetry = h.controller.getProcessedTake(take);
  assert.equal(await exportRetry, await playbackRetry); assert.equal(h.computations(), 2);
});
test('a source deleted during decode cannot republish stale Wet or final audio', async () => {
  let resolve; const state = scene(), raw = new BufferPCM(), h = audioHarness(state, () => new Promise(done => { resolve = done; }));
  const job = h.controller.getProcessedTake(state.lines[0]); await new Promise(done => setImmediate(done));
  h.controller.invalidateSource('main.webm'); resolve(raw); assert.equal(await job, null); assert.equal(h.computations(), 0); assert.equal(h.controller.cacheStats().noise.wetEntries, 0);
});

test('mix-only updates retain a pending preview source even outside the scene main slot', async () => {
  let resolve; const state = scene(), raw = new BufferPCM(), h = audioHarness(state, () => new Promise(done => { resolve = done; }));
  const historical = { ...state.lines[0], audioUrl: 'pending-historical.webm' }, job = h.controller.getProcessedTake(historical);
  await new Promise(done => setImmediate(done)); h.controller.updateLine(historical, { ...historical, volume: .25, pan: -1 });
  resolve(raw); assert.ok(await job); assert.equal(h.computations(), 1);
});
test('cancelled worker replies cannot complete replacement jobs; queued preview precedes background work', async () => {
  const workers = [];
  class Worker {
    constructor(url, options) { assert.equal(options.type, 'module'); workers.push(this); }
    postMessage(payload) { this.payload = payload; }
    terminate() { this.terminated = true; }
    complete() { const data = this.payload; this.onmessage({ data: { id: data.id, result: { channels: data.channels.map(c => c.slice()), metrics: {} } } }); }
  }
  const global = { addEventListener() {} }, context = { window: global, Worker, AbortController, DOMException, setTimeout, clearTimeout, performance };
  vm.runInNewContext(fs.readFileSync('src/public/noise-audio.js', 'utf8'), context);
  const api = global.DublineNoiseAudio, payload = () => ({ channels: [new Float32Array(64)], sampleRate: 48000 }), abort = new AbortController();
  const cancelled = api.run(payload(), abort.signal).catch(error => error.name), late = workers[0].onmessage, oldId = workers[0].payload.id;
  const next = api.run(payload()); abort.abort(); assert.equal(await cancelled, 'AbortError'); assert.equal(workers[0].terminated, true);
  late({ data: { id: oldId, result: { channels: [new Float32Array(64)] } } }); assert.equal(api.stats().active, true); workers[1].complete(); await next;
  const active = api.run(payload(), null, 'prefetch'), background = api.run(payload(), null, 'prefetch'), preview = api.run(payload(), null, 'preview');
  workers[1].complete(); await active; assert.equal(workers[1].payload.id, 5); workers[1].complete(); await preview; workers[1].complete(); await background;
  assert.equal(api.stats().active, false); assert.equal(api.stats().queuedBytes, 0); assert.equal(workers[1].onmessage, null);
});
test('format 9 retains actor settings, history, voice fields and exact original asset bytes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-rnnoise-project-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['video.mp4', 'main.webm', 'old.webm']) fs.writeFileSync(path.join(directory, name), Buffer.from(name));
  const s = scene(); s.lines.splice(1); Object.assign(s, { loaded: true, title: 'Noise', videoUrl: 'video.mp4', trackOrder: ['Role'], characterClaims: {}, kind: 'pack' });
  Object.assign(s.lines[0], { caption: 'text', start: 0, end: 2 });
  const saved = captureProject(s, url => path.join(directory, url)); assert.equal(saved.manifest.formatVersion, 9); assert.equal(saved.manifest.project.noiseReduction.revision, undefined);
  assert.equal(JSON.stringify(saved.manifest).includes('noiseProfileId'), false); assert.equal(JSON.stringify(saved.manifest).includes('profiles'), false);
  const staged = stageProject((await exportProject(s, url => path.join(directory, url))).buffer, directory); t.after(staged.rollback);
  assert.equal(staged.fields.lines[0].takeHistory[0].recordedBy, 'Actor'); assert.equal(staged.fields.lines[0].takeHistory[0].pinned, true);
  assert.equal(staged.fields.noiseReduction.actors.Actor.strength, .6); assert.equal(staged.fields.noiseReduction.revision, 0);
  for (const mutate of [m => m.project.noiseReduction.engineVersion = 'other', m => m.project.noiseReduction.actors.Actor.strength = 2,
    m => m.project.lines[0].take.noiseProfileId = null, m => m.project.noiseReduction.profiles = {}, m => m.project.noiseReduction.revision = 9]) {
    const bad = structuredClone(saved.manifest); mutate(bad); assert.throws(() => validateManifest(bad), /noise/i);
  }
  for (const version of [7, 8]) {
    const old = structuredClone(saved.manifest); old.formatVersion = version; old.project.noiseReduction = legacyState(); delete old.project.noiseReduction.revision;
    if (version === 7) delete old.project.roleEffects;
    for (const take of [old.project.lines[0].take, ...old.project.lines[0].takeHistory]) {
      take.noiseProfileId = 'old-profile'; if (version === 7) for (const field of voice.FIELDS) delete take[field];
    }
    validateManifest(old);
    const archive = new (require('adm-zip'))(); archive.addFile('project.json', Buffer.from(JSON.stringify(old)));
    for (const [name, bytes] of saved.files) archive.addFile(name, bytes);
    const migrated = stageProject(archive.toBuffer(), directory); t.after(migrated.rollback); const fields = migrated.fields;
    assert.deepEqual(fields.noiseReduction.actors.Actor, { enabled: false, strength: .6 }); assert.equal(JSON.stringify(fields).includes('noiseProfileId'), false);
    assert.equal(fields.lines[0].takeHistory[0].pinned, true); assert.equal(fields.lines[0].takeHistory[0].recordedBy, 'Actor');
    const bad = structuredClone(old); bad.project.lines[0].take.noiseProfileId = 'missing'; assert.throws(() => validateManifest(bad), /noise/i);
  }
  assert.equal(fs.readFileSync(path.join(directory, 'main.webm'), 'utf8'), 'main.webm');
});
