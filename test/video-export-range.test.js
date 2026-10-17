const { test } = require('node:test'), assert = require('node:assert/strict');
const policy = require('../src/public/video-export-policy');
test('export range validates numeric bounds and estimates only the requested duration', () => {
  assert.equal(policy.range(null, 12), null);
  assert.deepEqual(policy.range({ start: 2.137, end: 6.579 }, 12), { start: 2.137, end: 6.579 });
  for (const value of [{}, [], { start: '1', end: 2 }, { start: 0, end: Infinity }, { start: NaN, end: 2 }, { start: -1, end: 2 }, { start: 2, end: 2 }, { start: 4, end: 2 }, { start: 0, end: 13 }]) assert.throws(() => policy.range(value, 12), /range.invalid/);
  assert.equal(policy.estimate({ duration: 12, bitrate: 1000000 }, { range: { start: 2, end: 6 }, bitrate: 1000000 }), Math.ceil(4 * 1192000 / 8 * 1.02));
});
