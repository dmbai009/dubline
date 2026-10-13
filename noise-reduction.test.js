const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dsp = require('./public/noise-dsp'), model = require('./public/noise-model');
const noise = require('./server/noiseReduction'), history = require('./public/take-history-model');
const { captureProject, validateManifest, stageProject, exportProject } = require('./server/projects');
const profile = (id = 'profile-a', author = 'Actor') => ({ id, author, version: 1, fft: 1024, sampleRate: 48000, createdAt: 1, power: Array(513).fill(.01) });
function random(length, level = .01, seed = 77) {
  const pcm = new Float32Array(length); for (let i = 0; i < length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pcm[i] = ((seed / 4294967296) * 2 - 1) * level; } return pcm;
}
function process(pcm, profile, strength, rate = 48000) { const it = dsp.process(pcm, rate, profile, strength); let result; do { result = it.next(); } while (!result.done); return result.value; }
const rms = pcm => Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length);
test('six-second spectral profile rejects silence, clipping, incomplete capture and unstable speech-like bursts', () => {
  const pcm = random(288000), p = dsp.calibrate(pcm, 48000);
  assert.equal(model.validProfile({ ...p, id: 'p' }), true); assert.equal(p.power.length, 513);
  assert.throws(() => dsp.calibrate(new Float32Array(288000), 48000), /noSignal/);
  assert.throws(() => dsp.calibrate(pcm.slice(0, 1000), 48000), /incomplete/);
  const clipped = pcm.slice(); clipped[100] = 1; assert.throws(() => dsp.calibrate(clipped, 48000), /clipping/);
  const speech = pcm.slice(); for (let i = 96000; i < 144000; i++) speech[i] += .15 * Math.sin(i * .1);
  assert.throws(() => dsp.calibrate(speech, 48000), /unstable|speech/);
});
test('Wiener suppression attenuates noise during speech, preserves voiced bins, duration and raw bytes', () => {
  const calibration = random(288000, .02), p = dsp.calibrate(calibration, 48000);
  const noise = random(48000, .02, 300), voice = Float32Array.from({ length: 48000 }, (_, i) => .1 * Math.sin(2 * Math.PI * 1500 * i / 48000));
  const noisy = Float32Array.from(voice, (value, i) => value + noise[i]), original = noisy.slice(), output = process(noisy, p, .8);
  assert.deepEqual(noisy, original); assert.equal(output.length, noisy.length);
  const dryError = Float32Array.from(noisy, (value, i) => value - voice[i]), wetError = Float32Array.from(output, (value, i) => value - voice[i]);
  assert.ok(rms(wetError) < rms(dryError) * .9, `${rms(wetError)} versus ${rms(dryError)}`);
  assert.ok(rms(process(noise, p, .8)) < rms(noise) * .8);
  assert.deepEqual(process(noisy, p, 0), noisy);
  assert.ok([...output].every(Number.isFinite));
});
test('short, silent, whispered and alternate-rate samples never grow, shift or amplify noise', () => {
  const p = dsp.calibrate(random(288000), 48000);
  for (const rate of [44100, 48000]) for (const count of [1, 99, 1024, 6000]) {
    const pcm = random(count, .0001), out = process(pcm, p, 1, rate);
    assert.equal(out.length, count); assert.ok([...out].every(Number.isFinite)); assert.ok(rms(out) <= rms(pcm) * 1.01);
  }
  assert.deepEqual(process(new Float32Array(48000), p, 1), new Float32Array(48000));
});
function scene() {
  return { noiseReduction: { profiles: { 'profile-a': profile() }, actors: { Actor: { enabled: true, strength: .2, profileId: 'profile-a' } }, revision: 1 }, lines: [
    { id: 1, takeId: 'main-a', audioUrl: 'main.webm', recordedBy: 'Actor', effect: 'telephone', pitch: 3, volume: .7, pan: -.2, takeHistoryRevision: 2, takeHistory: [{ id: 'old-a', recordedBy: 'Actor', audioUrl: 'old.webm', noiseProfileId: 'profile-a', pinned: true }] },
    { id: 2, takeId: 'main-b', audioUrl: 'other.webm', recordedBy: 'Other', takeHistoryRevision: 0, takeHistory: [] }
  ] };
}
test('bulk changes are atomic, author-only, take-identity/revision-bound and preserve mix/timing', () => {
  const s = scene(), before = structuredClone(s), selected = { lineId: 1, takeId: 'main-a', historyRevision: 2 };
  const change = { revision: 1, takes: [selected], apply: true, profileId: 'profile-a' };
  const result = noise.plan(s, 'Actor', change);
  assert.deepEqual(s, before); assert.equal(result.lines[0].noiseProfileId, 'profile-a'); assert.equal(result.lines[0].effect, 'telephone'); assert.equal(result.lines[0].pan, -.2);
  for (const bad of [{ ...change, revision: 0 }, { ...change, takes: [{ ...selected, historyRevision: 1 }] }, { ...change, takes: [selected, { lineId: 2, takeId: 'main-b', historyRevision: 0 }] }, { ...change, takes: [{ ...selected, takeId: 'deleted' }] }]) assert.throws(() => noise.plan(s, 'Actor', bad), /noise\.(conflict|permission)/);
  assert.deepEqual(s, before);
});
test('recalibration affects future profile selection only; strength is common across old profiles', () => {
  const s = scene(), b = profile('profile-b');
  const result = noise.plan(s, 'Actor', { revision: 1, profile: b, actor: { enabled: true, strength: .5, profileId: b.id } });
  assert.equal(result.lines.length, 0); assert.equal(s.lines[0].takeHistory[0].noiseProfileId, 'profile-a');
  const old = model.resolve(s.lines[0].takeHistory[0], { noiseReduction: result.state });
  assert.equal(old.profile.id, 'profile-a'); assert.equal(old.strength, .5);
  assert.equal(noise.binding({ noiseReduction: result.state }, b.id, 'Actor'), b.id);
  assert.throws(() => noise.binding(s, 'profile-a', 'Other'), /profileMissing/);
});
test('different actors initialize future settings concurrently without rebasing existing settings or enrolling old takes', () => {
  const s = { noiseReduction: noise.empty(), lines: [] };
  const request = (name, id) => ({ revision: 0, initialize: true, profile: profile(id, name), actor: { enabled: true, strength: .2, profileId: id } });
  s.noiseReduction = noise.plan(s, 'Actor', request('Actor', 'a')).state;
  s.noiseReduction = noise.plan(s, 'Other', request('Other', 'b')).state;
  assert.equal(s.noiseReduction.revision, 2); assert.deepEqual(Object.keys(s.noiseReduction.actors).sort(), ['Actor', 'Other']);
  assert.throws(() => noise.plan(s, 'Actor', request('Actor', 'a')), /conflict/);
  s.lines.push({ id: 1, recordedBy: 'New', audioUrl: 'take.webm', noiseProfileId: 'a' });
  assert.throws(() => noise.plan(s, 'New', request('New', 'c')), /conflict/);
  assert.throws(() => noise.plan(s, 'Last', { ...request('Last', 'd'), takes: [] }), /conflict/);
  assert.throws(() => noise.plan(s, 'Last', { ...request('Last', 'd'), revision: 100 }), /conflict/);
  assert.throws(() => noise.plan(s, 'Actor', { revision: 2 }), /invalid/);
  assert.throws(() => noise.plan(s, 'Last', { ...request('Last', 'd'), actor: undefined }), /invalid/);
});
test('historical binding moves with identity on restore and deletion defaults clear only main binding', () => {
  const line = scene().lines[0]; line.noiseProfileId = 'profile-a'; const take = history.extract(line);
  assert.equal(take.noiseProfileId, 'profile-a');
  const restored = { audioUrl: null }; history.activate(restored, take); assert.equal(restored.noiseProfileId, 'profile-a');
  history.activate(restored, { ...take, noiseProfileId: null }); assert.equal(restored.noiseProfileId, null);
  assert.equal(require('./server/parsers').emptyTake().noiseProfileId, null);
});
test('profile validation bounds sizes, IDs, numeric values, authors and algorithm version', () => {
  const s = scene().noiseReduction; assert.equal(model.validState(s), true);
  for (const p of [{ ...profile(), power: [] }, { ...profile(), version: 99 }, { ...profile(), power: Array(513).fill(Infinity) }, { ...profile(), id: '../x' }]) assert.equal(model.validProfile(p), false);
  assert.throws(() => noise.plan(scene(), 'Actor', { revision: 1, profile: { ...profile(), power: [] } }), /invalid/);
  assert.throws(() => noise.plan(scene(), 'Other', { revision: 1, profile: profile() }), /conflict/);
});
test('controller cleans before effects, reuses matching settings, freezes export parameters and retries a temporary fallback', async () => {
  const vm = require('node:vm'), state = scene(), calls = []; let unavailable = false;
  const raw = { duration: 1, sampleRate: 48000 }, global = {
    DublineNoiseModel: model, DublineTakeMix: require('./public/take-mix'),
    DublineNoiseAudio: { clean: async (buffer, setting) => { calls.push(['clean', setting?.strength]); return setting && !unavailable ? { ...buffer, strength: setting.strength } : buffer; } },
    DublineAudioFx: { fetchAndDecode: async () => raw, renderVoice: async buffer => { calls.push(['effect', buffer.strength]); return buffer; }, effectTailSeconds: () => 0 }
  };
  const context = { window: global, console, setTimeout, clearTimeout, AbortController, Audio: function() {} };
  vm.runInNewContext(fs.readFileSync('public/audio.js', 'utf8'), context);
  const controller = global.DublineAudio.createController({ video: {}, backing: {}, getSession: () => state, getVolumes: () => ({}), getSettings: () => ({}), isRenderInProgress: () => false, getRecordingLineId: () => null });
  const take = { ...state.lines[0], noiseProfileId: 'profile-a' }, first = await controller.getProcessedTake(take);
  assert.equal(await controller.getProcessedTake(take), first); assert.deepEqual(calls, [['clean', .2], ['effect', .2]]);
  const snapshot = { ...take, _exportNoise: model.resolve(take, state) }; state.noiseReduction.actors.Actor.strength = .5;
  assert.equal((await controller.getProcessedTake(take)).strength, .5); assert.equal(await controller.getProcessedTake(snapshot), first);
  state.noiseReduction.actors.Actor.strength = .8; unavailable = true;
  assert.equal(await controller.getProcessedTake(take), raw); unavailable = false;
  assert.equal((await controller.getProcessedTake(take)).strength, .8);
});
test('completed worker jobs release handlers and cancelled jobs cannot strand the next queued task', async () => {
  const vm = require('node:vm'), workers = [];
  class Worker {
    constructor() { workers.push(this); }
    postMessage(payload) { this.payload = payload; }
    terminate() { this.terminated = true; }
    complete() { this.onmessage({ data: { result: process(this.payload.pcm, this.payload.profile, this.payload.strength) } }); }
  }
  const global = { addEventListener() {} }, context = { window: global, Worker, AbortController, DOMException, setTimeout, clearTimeout, console };
  vm.runInNewContext(fs.readFileSync('public/noise-audio.js', 'utf8'), context);
  const controller = new AbortController(), payload = () => ({ kind: 'clean', pcm: random(1024), sampleRate: 48000, profile: profile(), strength: .2 });
  const first = global.DublineNoiseAudio.run(payload(), controller.signal).catch(error => error.name), next = global.DublineNoiseAudio.run(payload());
  assert.equal(workers.length, 1); controller.abort(); assert.equal(await first, 'AbortError');
  assert.equal(workers[0].terminated, true); assert.equal(workers.length, 2); workers[1].complete();
  assert.equal((await next).length, 1024); assert.equal(workers[1].onmessage, null); assert.equal(workers[1].onerror, null);
  assert.equal(global.DublineNoiseAudio.stats().active, false); assert.equal(global.DublineNoiseAudio.stats().queued, 0);
});
test('version 7 project preserves deduplicated profiles, history and original bytes; malformed refs rejected', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-noise-project-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['video.mp4', 'main.webm', 'old.webm']) fs.writeFileSync(path.join(dir, name), Buffer.from(name));
  const s = scene(); s.lines.splice(1); Object.assign(s, { loaded: true, title: 'Noise', videoUrl: 'video.mp4', trackOrder: ['Role'], characterClaims: {}, kind: 'pack' });
  Object.assign(s.lines[0], { character: 'Role', caption: 'text', start: 0, end: 2, noiseProfileId: 'profile-a' });
  const saved = captureProject(s, url => path.join(dir, url)); assert.equal(saved.manifest.formatVersion, 7); assert.equal(Object.keys(saved.manifest.project.noiseReduction.profiles).length, 1);
  const opened = stageProject((await exportProject(s, url => path.join(dir, url))).buffer, dir); t.after(opened.rollback);
  assert.equal(opened.fields.lines[0].noiseProfileId, 'profile-a'); assert.equal(opened.fields.lines[0].takeHistory[0].noiseProfileId, 'profile-a'); assert.equal(opened.fields.noiseReduction.revision, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'main.webm'), 'utf8'), 'main.webm');
  for (const mutate of [m => m.formatVersion = 6, m => m.project.lines[0].take.noiseProfileId = 'missing', m => m.project.noiseReduction.profiles['profile-a'].version = 99, m => m.project.noiseReduction.actors.Actor.strength = 2]) { const bad = structuredClone(saved.manifest); mutate(bad); assert.throws(() => validateManifest(bad), /noise/i); }
  delete s.noiseReduction; assert.throws(() => captureProject(s, url => path.join(dir, url)), /missing noise profile/);
});
