const test = require('node:test'), assert = require('node:assert/strict');
const { ByteCache, IntervalIndex } = require('./public/audio-memory');
test('waveform peak arrays use actual typed-array bytes and reject oversized retained entries',async()=>{
  const cache=new ByteCache(8);
  cache.set('first',Promise.resolve(new Float32Array(2)));await Promise.resolve();assert.equal(cache.bytes,8);
  cache.set('second',Promise.resolve(new Float32Array(2)));await Promise.resolve();assert.equal(cache.has('first'),false);assert.equal(cache.bytes,8);
  const oversized=Promise.resolve(new Float32Array(3));cache.set('large',oversized);await Promise.resolve();
  assert.equal(cache.bytes,0);assert.equal(cache.size,0);assert.equal((await oversized).byteLength,12,'consumer can use a result without retaining it');
});
test('PCM cache counts frames times channels times four and evicts least recently used unpinned buffers', async () => {
  const pins = new Set(['active']), cache = new ByteCache(1000, key => pins.has(key));
  const pcm = () => ({ length: 100, numberOfChannels: 2, duration: 2 });
  cache.set('active', Promise.resolve(pcm())); await Promise.resolve();
  cache.set('old', Promise.resolve(pcm())); await Promise.resolve();
  assert.equal(cache.bytes, 800); assert.equal(cache.has('active'), true); assert.equal(cache.has('old'), false);
  assert.equal(cache.duration('active'), 2); assert.equal(cache.duration('old'), 0);
  pins.clear(); cache.set('new', Promise.resolve(pcm())); await Promise.resolve();
  assert.equal(cache.has('active'), false); assert.equal(cache.bytes, 800); assert.equal(cache.evictions, 2);
  cache.clear(); assert.equal(cache.bytes, 0); assert.equal(cache.durations.size, 0);
});
for (const count of [400, 1000, 2000]) test(`interval scheduling visits a bounded subset of ${count} cues and preserves overlapping lines`, () => {
  const entries = Array.from({ length: count }, (_, index) => ({ start: index * 2, end: index * 2 + 3, value: index }));
  const tree = new IntervalIndex(entries);
  assert.deepEqual(tree.query(401), [199, 200]); assert.ok(tree.visited < 32, `visited ${tree.visited}`);
  assert.deepEqual(tree.query(400, 404), [199, 200, 201, 202]);
  assert.deepEqual(tree.query(20000), []); assert.equal(tree.visited, 0);
});
