// Reproducible DSP cost/quality fixture. All outputs are ignored, originals read-only.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const dsp = require('../public/noise-dsp');
const directory = path.resolve('audit/noise-reduction'); fs.mkdirSync(directory, { recursive: true });
function random(count, seed = 17, level = .006) { return Float32Array.from({ length: count }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 4294967296 * 2 - 1) * level; }); }
function clean(pcm, p, strength) { const iterator = dsp.process(pcm, 48000, p, strength); let step; do { step = iterator.next(); } while (!step.done); return step.value; }
function rms(pcm) { return Math.sqrt(pcm.reduce((sum, v) => sum + v * v, 0) / pcm.length); }
function wav(file, pcm) {
  const bytes = Buffer.alloc(44 + pcm.length * 2); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2); fs.writeFileSync(path.join(directory, file), bytes);
}
const profile = { ...dsp.calibrate(random(288000), 48000), id: 'benchmark' };
const result = { node: process.version, rate: 48000, algorithm: 1, calibrationSeconds: 6, scenes: [], voices: [] };
const voiceRoot = process.argv[2];
if (voiceRoot) {
  // Inspect only owned line recordings; no project credentials or room metadata.
  const candidates = fs.readdirSync(voiceRoot).filter(name => /^line_.*\.(webm|wav)$/i.test(name));
  for (const name of candidates) {
    if (result.voices.length === 3) break;
    const decode = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-i', path.join(voiceRoot, name), '-t', '4', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { windowsHide: true, maxBuffer: 4 * 1024 ** 2 });
    if (decode.status || decode.stdout.length < 48000 * 4) continue;
    const dry = new Float32Array(decode.stdout.buffer.slice(decode.stdout.byteOffset, decode.stdout.byteOffset + decode.stdout.length)); if (rms(dry) < .01) continue;
    const noise = random(dry.length), noisy = Float32Array.from(dry, (value, i) => value + noise[i]), label = `voice-${result.voices.length + 1}`;
    wav(label + '-original.wav', dry); wav(label + '-noisy.wav', noisy);
    const measurements = [];
    for (const strength of [.2, .5, 1]) { const start = performance.now(), processed = clean(noisy, profile, strength), error = Float32Array.from(processed, (value, i) => value - dry[i]); wav(label + '-clean-' + Math.round(strength * 100) + '.wav', processed); measurements.push({ strength, milliseconds: performance.now() - start, errorRms: rms(error), samples: processed.length }); }
    result.voices.push({ label, samples: dry.length, dryRms: rms(dry), addedNoiseRms: rms(noise), measurements });
  }
}
const pcm = random(72000); for (let i = 0; i < pcm.length; i++) pcm[i] += .08 * Math.sin(2 * Math.PI * 230 * i / 48000);
for (const count of [1, 400]) {
  const before = process.memoryUsage(), started = performance.now(); let peak = before.arrayBuffers;
  for (let i = 0; i < count; i++) { clean(pcm, profile, .2); peak = Math.max(peak, process.memoryUsage().arrayBuffers); }
  result.scenes.push({ takes: count, totalAudioSeconds: count * 1.5, milliseconds: performance.now() - started, beforeArrayBuffers: before.arrayBuffers, sampledPeakArrayBuffers: peak, afterArrayBuffers: process.memoryUsage().arrayBuffers });
}
fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
