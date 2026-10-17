const { test } = require('node:test');
const assert = require('node:assert/strict');
const { correction } = require('../src/public/voice-level');
function signal(level = .1) { return Float32Array.from({ length: 4800 }, (_, i) => i < 960 || i > 3800 ? 0 : level * Math.sin(i * .12)); }
test('speech level compares a take with its own processed windows and ignores silence and tails', () => {
  const dry = signal(), wet = Float32Array.from(dry, value => value * 4);
  assert.ok(Math.abs(correction(dry, wet, 48000).gain - .25) < 1e-6);
  const tail = new Float32Array(24000); tail.set(wet); tail.fill(.4, wet.length);
  assert.ok(Math.abs(correction(dry, tail, 48000).gain - .25) < 1e-6);
});
test('almost silent inputs cannot be boosted into noise, gain is bounded and output peak stays safe', () => {
  assert.equal(correction(signal(1e-5), signal(1e-6), 48000).gain, 1);
  assert.equal(correction(signal(.2), signal(.001), 48000).gain, 2);
  const wet = signal(.6); wet[2000] = 3;
  assert.ok(correction(signal(.8), wet, 48000).gain * 3 <= .95 + 1e-9);
  assert.equal(correction(new Float32Array(20), new Float32Array(20), 48000).gain, 1);
});
test('short takes, quiet endings and trimmed preparation retain finite stable correction', () => {
  const dry = Float32Array.from([.02, -.03, .01]), wet = Float32Array.from(dry, value => value * 2);
  assert.equal(correction(dry, wet, 48000).gain, .5);
  assert.equal(correction(signal(), signal(.2), 48000, 1100, 3400).gain, .5);
});
