const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const mix = require('./public/take-mix');
const { captureProject, exportProject, readProject, stageProject, validateManifest } = require('./server/projects');

test('legacy clip defaults and author/host rights survive released or reassigned roles', () => {
  assert.deepEqual(mix.normalize({ volume: NaN, pan: 2, effectAmount: null }), mix.DEFAULTS);
  assert.equal(mix.valid('volume', '1'), false);
  assert.equal(mix.valid('pan', Infinity), false);
  const take = { recordedBy: 'Alice' };
  assert.equal(mix.canEdit(take, 'Alice', false, 'Bob'), true);
  assert.equal(mix.canEdit(take, 'Bob', false, 'Bob'), false);
  assert.equal(mix.canEdit(take, 'Host', true, null), true);
  assert.equal(mix.canEdit({}, 'Bob', false, 'Bob'), true);
});

function fixture(t, source = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-clip-project-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['working.mp4', 'take.wav', 'source.mkv']) fs.writeFileSync(path.join(dir, name), 'fixture:' + name);
  return { dir, resolve: url => path.join(dir, url), scene: { loaded: true, title: 'Mix', videoUrl: 'working.mp4',
    ...(source ? { originalVideoUrl: 'source.mkv', originalVideoName: 'Episode.mkv' } : {}),
    trackOrder: ['Hero'], lines: [{ id: 1, character: 'Hero', start: 0, end: 1, audioUrl: 'take.wav', recordedBy: 'Alice',
      volume: 0.37, pan: -0.64, effectAmount: 0.25, effect: 'monster', pitch: 3, takeMixRevision: 81 }] } };
}

for (const source of [false, true]) test(`format 3 round-trip keeps clip mixes and ${source ? 'original/proxy media' : 'a regular video'}`, async t => {
  const f = fixture(t, source), saved = await exportProject(f.scene, f.resolve), parsed = readProject(saved.buffer);
  assert.equal(parsed.manifest.formatVersion, 3);
  const take = parsed.manifest.project.lines[0].take;
  for (const field of ['volume', 'pan', 'effectAmount', 'effect', 'pitch']) assert.equal(take[field], f.scene.lines[0][field]);
  assert.equal(JSON.stringify(parsed.manifest).includes('takeMixRevision'), false);
  const staged = stageProject(saved.buffer, f.dir);
  t.after(() => staged.rollback());
  assert.deepEqual(mix.normalize(staged.fields.lines[0]), { volume: 0.37, pan: -0.64, effectAmount: 0.25 });
  assert.equal(staged.fields.lines[0].takeMixRevision, 0);
  assert.equal(!!staged.fields.originalVideoUrl, source);
});

test('format 3 strictly rejects invalid or missing clip settings and downgraded mixes', t => {
  const f = fixture(t), manifest = captureProject(f.scene, f.resolve).manifest;
  for (const [field, value] of [['volume', -1], ['volume', 3.01], ['pan', 1.01], ['pan', '0'], ['effectAmount', NaN], ['effectAmount', null]]) {
    const m = structuredClone(manifest); m.project.lines[0].take[field] = value;
    assert.throws(() => validateManifest(m), /Invalid clip mix/);
  }
  const missing = structuredClone(manifest); delete missing.project.lines[0].take.pan;
  assert.throws(() => validateManifest(missing), /Invalid clip mix/);
  const old = structuredClone(manifest); old.formatVersion = 1;
  assert.throws(() => validateManifest(old), /requires project version 3/);
});

for (const source of [false, true]) test(`default clips emit legacy format ${source ? 2 : 1} and open with default mix`, async t => {
  const f = fixture(t, source); Object.assign(f.scene.lines[0], mix.DEFAULTS);
  const saved = await exportProject(f.scene, f.resolve), parsed = readProject(saved.buffer);
  assert.equal(parsed.manifest.formatVersion, source ? 2 : 1);
  assert.equal(parsed.manifest.project.lines[0].take.volume, undefined);
  const staged = stageProject(saved.buffer, f.dir); t.after(() => staged.rollback());
  assert.deepEqual(mix.normalize(staged.fields.lines[0]), mix.DEFAULTS);
});

test('effect amount belongs to processing cache identity; volume and pan reuse the decoded take', async () => {
  let downloads = 0, renders = 0;
  const fx = { fetchAndDecode: async () => { downloads++; return { duration: 1 }; }, renderVoice: async (buffer, effect, pitch, bounds, amount) => { renders++; return { amount }; } };
  const context = { window: { DublineTakeMix: mix, DublineAudioFx: fx }, console, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync('public/audio.js', 'utf8'), context);
  const audio = context.window.DublineAudio.createController({ getSession: () => null });
  const line = { audioUrl: '/take', effect: 'radio', effectAmount: 1 };
  const first = await audio.getProcessedTake(line);
  assert.equal(await audio.getProcessedTake({ ...line, volume: 0.2, pan: -1 }), first);
  assert.equal((await audio.getProcessedTake({ ...line, effectAmount: 0.5 })).amount, 0.5);
  assert.equal((await audio.getProcessedTake({ ...line, effectAmount: 0 })).amount, 0);
  assert.equal(downloads, 1); assert.equal(renders, 3);
});
