const { test } = require('node:test'), assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const model = require('./public/speech-model');
const sine = (amplitude, seconds = 1, rate = 48000, frequency = 997, phase = 0) => Float32Array.from({ length: rate * seconds }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / rate + phase));
test('K weighting reproduces the 48 kHz reference coefficients and 997 Hz calibration', () => {
  const [shelf, highpass] = model.coefficients(48000); for (const [actual, expected] of shelf.map((value, i) => [value, [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, .73248077421585][i]])) assert.ok(Math.abs(actual - expected) < 1e-8);
  assert.ok(Math.abs(highpass[3] + 1.99004745483398) < 1e-8);
  assert.ok(Math.abs(model.level([sine(1)], 48000).lufs + 3.01) < .04); assert.ok(Math.abs(model.level([sine(.1, 1, 44100)], 44100).lufs + 23.01) < .05);
});
test('loudness gating excludes long silence, stereo sums channels, and short clips stay finite', () => {
  const voice = sine(.1), withSilence = new Float32Array(48000 * 5); withSilence.set(voice, 48000 * 2);
  const measured = model.level([withSilence], 48000), reference = model.level([voice], 48000); assert.ok(Math.abs(measured.lufs - reference.lufs) < 1.2);
  assert.ok(Math.abs(model.level([voice, voice], 48000).lufs - reference.lufs - 3.0103) < .02); assert.ok(Number.isFinite(model.level([sine(.1, .15)], 48000).lufs));
});
test('near silence and whispers remain unboosted; expressive loudness and peak protection are bounded', () => {
  assert.equal(model.gain(model.level([sine(.001)], 48000)), 1); assert.equal(model.gain(model.level([new Float32Array(48000)], 48000)), 1);
  const quiet = model.level([sine(.025)], 48000), loud = model.level([sine(.8)], 48000); assert.ok(model.gain(quiet) <= 10 ** (6 / 20)); assert.ok(model.gain(loud) >= 10 ** (-6 / 20) - .001); assert.ok(model.gain(loud) * loud.truePeak <= .89 + 1e-6);
});
test('the four-times peak estimate identifies a peak between samples and agrees with independent FFmpeg analysis', () => {
  const signal = sine(.9, 1, 48000, 12000, Math.PI / 4); for (let i = 0; i < 960; i++) { const fade = .5 - .5 * Math.cos(Math.PI * i / 960); signal[i] *= fade; signal[signal.length - 1 - i] *= fade; } const measured = model.level([signal], 48000); assert.ok(measured.truePeak > measured.peak * 1.3);
  const result = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { input: Buffer.from(signal.buffer), encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr);
  const match = /True peak:[\s\S]*?Peak:\s+(-?[\d.]+)\s+dBFS/.exec(result.stderr); assert.ok(match, result.stderr); assert.ok(Math.abs(20 * Math.log10(measured.truePeak) - Number(match[1])) < .35);
});
test('technical quality hints do not reject clips, request retakes or flag ordinary whisper/short expressive speech', () => {
  const empty = model.quality([new Float32Array(48000)], 48000); assert.deepEqual(empty.warnings, ['empty']); assert.ok(model.validQuality(empty));
  const clipped = sine(1.3); for (let i = 0; i < clipped.length; i++) clipped[i] = Math.max(-1, Math.min(1, clipped[i])); assert.ok(model.quality([clipped], 48000).warnings.includes('clipped'));
  assert.deepEqual(model.quality([sine(.002)], 48000).warnings, []); assert.deepEqual(model.quality([sine(.6, .15)], 48000).warnings, []);
  assert.equal(model.validQuality({ ...empty, needsRetake: true }), false); assert.equal(model.validQuality({ ...empty, peak: NaN }), false);
});


test('stationary broad noise and ambiguous unvoiced clips are not amplified', () => {
  let seed = 917; const noise = Float32Array.from({ length: 48000 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return .03 * (seed / 2 ** 32 * 2 - 1); }); const result = model.level([noise], 48000); assert.equal(result.voiced, false); assert.ok(model.gain(result) <= 1); assert.ok(model.gain(model.level([sine(.025)], 48000)) > 1);
});


test('abrupt burst boundaries keep headroom in independent true-peak analysis after correction', () => {
  const signal = new Float32Array(48000 * 2), burst = sine(.9, .04, 48000, 12000, Math.PI / 4); signal.set(burst, 48000); const gain = model.gain(model.level([signal], 48000)), corrected = Float32Array.from(signal, value => value * gain);
  const result = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { input: Buffer.from(corrected.buffer), encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); const match = /True peak:[\s\S]*?Peak:\s+(-?[\d.]+)\s+dBFS/.exec(result.stderr); assert.ok(match, result.stderr); assert.ok(Number(match[1]) <= -1, match[1]);
});

test('low-frequency stationary hum is not mistaken for a periodic speech peak', () => { assert.equal(model.level([sine(.05, 1, 48000, 50)], 48000).voiced, false); assert.equal(model.gain(model.level([sine(.05, 1, 48000, 50)], 48000)), 1); });
