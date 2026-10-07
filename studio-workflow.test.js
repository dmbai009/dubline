const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('./public/project-audio');
const adr = require('./public/adr-cues');

test('legacy mix migration and external / embedded source selection', () => {
  assert.deepEqual(model.gains(model.normalize({ videoUrl: '/video' })), { original: 1, backing: 1, dub: 1 });
  assert.equal(model.normalize({ backingUrl: '/background' }).original.volume, 0);
  assert.deepEqual(model.sources({ videoUrl: '/video' }), { original: '/video', backing: '' });
  const scene = { videoUrl: '/video', audioTracks: [{ url: '/one' }, { url: '/two' }], originalTrack: 1, backingUrl: '/background' };
  assert.equal(model.sources(scene).original, '/two');
  assert.equal(model.sources({ ...scene, originalTrack: -1 }).original, '');
  assert.equal(model.sources({ ...scene, externalOriginalUrl: '/external' }).original, '/external');
});
test('mix clamps malformed persisted values, applies mute / solo and keeps millisecond offsets', () => {
  const mix = model.normalize({ projectAudio: { revision: 4, original: { volume: 3, offset: -1.4204 }, backing: { volume: NaN, offset: Infinity }, dub: { muted: true } } });
  assert.equal(mix.original.volume, 1.5, 'volumes go up to 150 %'); assert.equal(mix.original.offset, -1.42); assert.equal(mix.backing.offset, 0);
  assert.deepEqual(model.gains(mix), { original: 1.5, backing: 1, dub: 0 });
  mix.backing.solo = true;
  assert.deepEqual(model.gains(mix), { original: 0, backing: 1, dub: 0 });
  assert.equal(model.normalize({ projectAudio: { dub: { offset: 5 } } }).dub.offset, undefined);
});
test('ADR re-armed after the video starts skips beats already in the past', () => {
  const starts = [];
  const param = { setValueAtTime() {}, linearRampToValueAtTime() {} };
  class Context {
    constructor() { this.destination = 'speakers'; this.currentTime = 10; }
    createGain() { return { gain: param, connect() {}, disconnect() {} }; }
    createOscillator() { return { frequency: {}, connect() {}, start(at) { starts.push(at); }, stop() {}, disconnect() {} }; }
  }
  const cues = adr.create(Context);
  cues.arm(2.5); // the video started late: only the beats 2 s and 1 s before the line remain
  assert.deepEqual(starts, [10.5, 11.5]);
});
test('positive and negative offsets describe the same placement for waveform, playback and export', () => {
  for (const offset of [-2.123, 0, 1.234, 10]) {
    const placement = model.placement(offset, 4);
    assert.equal(model.sourceTime(placement.when, offset), placement.from);
    assert.equal(placement.duration, 4 - placement.from);
  }
  assert.equal(model.placement(-8, 4).duration, 0);
});
test('first visit uses English even on a Russian system; choice persists and invalid preferences reset', async () => {
  const values = new Map();
  const context = { window: { dispatchEvent() {} }, navigator: { language: 'ru-RU' }, document: { documentElement: {}, querySelectorAll: () => [] },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, CustomEvent: function() {} };
  const source = fs.readFileSync('public/i18n.js', 'utf8');
  for (const language of ['en', 'uk']) vm.runInNewContext(fs.readFileSync('public/locale/' + language + '.js', 'utf8'), context);
  vm.runInNewContext(source, context);
  assert.equal(context.window.DublineI18n.getLanguage(), 'en');
  await context.window.DublineI18n.setLanguage('uk'); vm.runInNewContext(source, context);
  assert.equal(context.window.DublineI18n.getLanguage(), 'uk');
  values.set('dubline_language', 'invalid'); vm.runInNewContext(source, context);
  assert.equal(context.window.DublineI18n.getLanguage(), 'en');
});
test('ADR schedules three one-second beats ahead of time, cancels all nodes and connects only to speakers', () => {
  const connected = [], oscillators = [];
  const param = { setValueAtTime() {}, linearRampToValueAtTime() {} };
  class Context {
    constructor() { this.destination = 'speakers'; this.currentTime = 0; }
    createGain() { return { gain: param, connect: target => connected.push(target), disconnect() {} }; }
    createOscillator() {
      const node = { frequency: {}, connect: target => connected.push(target), start(at) { node.at = at; }, stop() { node.stopped = true; }, disconnect() {} };
      oscillators.push(node); return node;
    }
  }
  const cues = adr.create(Context);
  assert.equal(adr.preparation(1, false), 1); assert.equal(adr.preparation(0.1, true), 3); assert.equal(adr.preparation(5, true), 5);
  assert.equal(oscillators.length, 0, 'off by default');
  cues.arm(5);
  assert.equal(oscillators.length, 3); assert.equal(connected.filter(target => target === 'speakers').length, 3);
  assert.deepEqual(oscillators.map(node => node.at), [2, 3, 4], 'UI ticks are not needed, including in a background tab');
  cues.stop(); assert.equal(oscillators.length, 3); assert.ok(oscillators.every(node => node.stopped));
});
test('a draft conflict does not freeze subsequent changes to unrelated fields', () => {
  const source = fs.readFileSync('public/editor.js', 'utf8');
  const start = source.indexOf('function sameEditorValue('), end = source.indexOf('// "Keep my version"');
  const context = { EDITOR_FORM_FIELDS: ['caption', 'character', 'start', 'end'], editorDrafts: new Map() };
  vm.runInNewContext(source.slice(start, end), context);
  const draft = { base: { caption: 'old', character: 'A', start: 1, end: 4 }, values: { caption: 'mine', character: 'A', start: '1', end: '4' } };
  assert.equal(context.mergeEditorDraft('test', draft, { caption: 'theirs', character: 'A', start: 2, end: 4 }), true);
  assert.equal(context.mergeEditorDraft('test', draft, { caption: 'theirs', character: 'A', start: 3, end: 4 }), true);
  assert.equal(draft.values.start, '3'); assert.equal(draft.values.caption, 'mine');
});
