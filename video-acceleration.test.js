const { test } = require('node:test'), assert = require('node:assert/strict');
const policy = require('./public/video-acceleration');
const { createAcceleration, encoderArgs } = require('./server/video-acceleration');
const large = { width: 1920, height: 1080, duration: 120 };
test('automatic selection keeps small work on CPU, and on/off override size', () => {
  assert.equal(policy.normalize('arbitrary ffmpeg arguments'), 'auto');
  assert.equal(policy.preference('auto', large), 'prefer-hardware');
  assert.equal(policy.preference('auto', { ...large, duration: 5 }), 'prefer-software');
  assert.equal(policy.preference('on', {}), 'prefer-hardware');
  assert.equal(policy.preference('off', large), 'prefer-software');
  assert.throws(() => encoderArgs('libx264 -i untrusted'));
});
test('unsupported GPU configuration falls back to software; off never probes hardware', async () => {
  const calls = [], mb = { canEncodeVideo: async (_codec, config) => { calls.push(config.hardwareAcceleration); return config.hardwareAcceleration === 'prefer-software'; } };
  assert.equal(await policy.encoderPreference(mb, 'avc', { width: 1280 }, 'on', large), 'prefer-software');
  assert.deepEqual(calls, ['prefer-hardware', 'prefer-software']); calls.length = 0;
  await policy.encoderPreference(mb, 'avc', {}, 'off', large); assert.deepEqual(calls, ['prefer-software']);
});
test('FFmpeg acceleration requires a real probe and caches failed driver probes', async () => {
  const probes = [];
  const service = createAcceleration({ list: async () => ['h264_nvenc', 'h264_qsv'], probe: async encoder => { probes.push(encoder); if (encoder === 'h264_nvenc') throw Error('driver unavailable'); } });
  assert.equal(await service.choose('on', large), 'h264_qsv');
  assert.equal(await service.choose('on', large), 'h264_qsv');
  assert.deepEqual(probes, ['h264_nvenc', 'h264_qsv']);
  probes.length = 0;
  assert.equal(await service.choose('off', large), 'libx264'); assert.deepEqual(probes, []);
});
test('a rejected WebCodecs hardware probe still permits software encoding', async () => {
  const mb = { canEncodeVideo: async (_codec, config) => { if (config.hardwareAcceleration === 'prefer-hardware') throw Error('device probe failed'); return true; } };
  assert.equal(await policy.encoderPreference(mb, 'avc', {}, 'on', large), 'prefer-software');
});
test('a failed hardware encode retries exactly once on CPU, while cancellation never retries', async () => {
  const service = createAcceleration({ list: async () => ['h264_nvenc'], probe: async () => {} }), attempts = [], backends = [];
  const result = await service.run({ mode: 'on', info: large, onBackend: (...args) => backends.push(args) }, async encoder => { attempts.push(encoder); if (encoder !== 'libx264') throw Error('device lost'); return 'complete'; });
  assert.equal(result, 'complete'); assert.deepEqual(attempts, ['h264_nvenc', 'libx264']);
  assert.deepEqual(backends, [['h264_nvenc', false], ['libx264', true]]);
  const cancelled = createAcceleration({ list: async () => ['h264_qsv'], probe: async () => {} }), abort = new AbortController(); let count = 0;
  await assert.rejects(cancelled.run({ mode: 'on', info: large, signal: abort.signal }, async () => { count++; abort.abort(); abort.signal.throwIfAborted(); }), { name: 'AbortError' });
  assert.equal(count, 1);
});
test('off and automatic small jobs never enumerate devices', async () => {
  const service = createAcceleration({ list: async () => { throw Error('must not probe'); } });
  assert.equal(await service.choose('off', large), 'libx264');
  assert.equal(await service.choose('auto', { ...large, duration: 1 }), 'libx264');
});
test('the local preference survives a reload without becoming session state', () => {
  const fs = require('node:fs'), vm = require('node:vm'), values = new Map();
  const load = () => { const window = { localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }, dispatchEvent() {} }; vm.runInNewContext(fs.readFileSync('./public/video-acceleration.js', 'utf8'), { window, Event: class {} }); return window; };
  const first = load(); assert.equal(first.DublineVideoAcceleration.get(), 'auto'); first.DublineVideoAcceleration.set('off');
  assert.equal(load().DublineVideoAcceleration.get(), 'off'); assert.equal(first.session, undefined);
});
