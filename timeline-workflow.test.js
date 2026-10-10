const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const timeline = require('./public/timeline-model');
const adr = require('./public/adr-cues');

test('role lane geometry divides extra height, preserves padding and expands for new overlaps', () => {
  for (const count of [1, 2, 4, 12]) {
    for (const preference of [undefined, NaN, Infinity, -4, 100, 350, 600, 999]) {
      const g = timeline.laneGeometry(count, preference);
      assert.ok(g.cueHeight >= 48);
      assert.ok(Math.abs(g.padding * 2 + g.cueHeight * count + g.gap * (count - 1) - g.height) < 1e-8);
      assert.ok(g.height >= g.minimum);
    }
  }
  assert.equal(timeline.laneGeometry(1, 210).cueHeight, 198);
  assert.equal(timeline.laneGeometry(2, 210).cueHeight, 96);
  assert.equal(timeline.laneGeometry(1, 60).height, 80, 'old small preferences fit the role controls without being rewritten');
  assert.equal(timeline.laneGeometry(2).height, 114, 'overlap lanes still determine larger minimums');
});

test('timeline creation uses real duration, including the last fraction of a second', () => {
  assert.deepEqual(timeline.create(1.234, 8), { start: 1.234, end: 3.234 });
  assert.deepEqual(timeline.create(7.99, 8), { start: 7.9, end: 8 });
  for (const at of [8, 8.01, -1, NaN, Infinity]) assert.equal(timeline.create(at, 8), null);
  assert.equal(timeline.create(0, 0.05), null);
});
test('all timing inputs enforce the same millisecond media boundary', () => {
  assert.equal(timeline.valid(1, 8.001, 8), null);
  assert.equal(timeline.valid(-0.001, 2, 8), null);
  assert.equal(timeline.valid(2, 2, 8), null);
  assert.deepEqual(timeline.valid(7.9, 8, 8), { start: 7.9, end: 8 });
  assert.equal(timeline.valid(7.9, 8, 7.9999), null);
});
test('group movement and both resize handles clamp at the media edges', () => {
  const group = [{ id: 1, start: 1, end: 2 }, { id: 2, start: 4, end: 6 }];
  assert.equal(timeline.move(group, -50, 8), -1);
  assert.equal(timeline.move(group, 50, 8), 2);
  assert.deepEqual(timeline.resize(group[0], 'start', -50, 8), { start: 0, end: 2 });
  assert.deepEqual(timeline.resize(group[0], 'end', 50, 8), { start: 1, end: 8 });
  assert.deepEqual(timeline.resize(group[0], 'start', 50, 8), { start: 1.9, end: 2 });
});
test('mixed-track movement keeps relative roles and refuses the entire group at an edge', () => {
  const group = [{ id: 1, character: 'A' }, { id: 2, character: 'B' }], tracks = ['A', 'B', 'C'];
  assert.deepEqual([...timeline.roles(group, tracks, 1)], [[1, 'B'], [2, 'C']]);
  assert.equal(timeline.roles(group, tracks, -1), null);
  assert.equal(timeline.roles([{ id: 1, character: 'B' }, { id: 2, character: 'C' }], tracks, 1), null);
});
test('coordinate conversion includes an already-scrolled and zoomed origin', () => {
  assert.equal(timeline.coordinate(500, -250, 150), 5);
  assert.equal(timeline.coordinate(500, 200, 60), 5);
});
test('ADR volume controls speaker cue gain without connecting to a recording destination', () => {
  const levels = [], connections = [], gains = [];
  class Context {
    constructor() { this.destination = 'speakers'; this.currentTime = 0; }
    createGain() { const node = { gain: { setValueAtTime() {}, linearRampToValueAtTime(value) { if (value) levels.push(value); } }, connect(to) { connections.push(to); }, disconnect() {} }; gains.push(node); return node; }
    createOscillator() { return { frequency: {}, connect() {}, start() {}, stop() {}, disconnect() {} }; }
  }
  let volume = 0.25; const cues = adr.create(Context, () => volume);
  cues.arm(3); assert.deepEqual(levels, [0.03, 0.03, 0.03]);
  volume = 1; cues.arm(3); assert.deepEqual(levels.slice(3), [0.12, 0.12, 0.12]);
  assert.equal(connections.filter(to => to === 'speakers').length, 1);
  assert.ok(connections.every(to => to === 'speakers' || to === gains[0]), 'cue gain nodes connect only through the listening master bus');
});
test('persisted enabled ADR clamps preparation on reload and keeps cue volume local', () => {
  const values = new Map([['dubline_adr', 'three'], ['dubline_pre_roll', '1'], ['dubline_adr_volume', '0.35']]);
  const context = { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, crypto: { randomUUID: () => 'client' } };
  context.window = context; vm.runInNewContext(fs.readFileSync('public/state.js', 'utf8'), context);
  assert.equal(context.preRollSeconds, 3); assert.equal(context.adrCueVolume, 0.35);
  for (const at of [0, 1, 2.9]) assert.equal(adr.preparation(at, true), 3);
  for (const at of [3, 4, 5]) assert.equal(adr.preparation(at, true), at);
  assert.equal(adr.preparation(0, false), 0);
});

test('visible chronological numbering is independent of stable IDs and does not mutate takes', () => {
  const lines=[{id:1,start:104.97,audioUrl:'/take-1'}, {id:36,start:24.92,audioUrl:'/take-36'}, {id:37,start:27.42,audioUrl:'/take-37'}];
  const before=structuredClone(lines);
  assert.deepEqual([...timeline.numbers(lines)], [[36,1],[37,2],[1,3]]);
  assert.deepEqual(lines,before);
});
