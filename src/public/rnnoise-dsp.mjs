import { SincKernel, OutputResampler } from './rnnoise-resample.mjs';
export const RATE = 48000, FRAME = 480, DELAY = 960;
let loaded;
async function runtime() {
  if (!loaded) {
    loaded = import('./vendor/rnnoise/rnnoise.js').then(module => module.Rnnoise.load());
    loaded.catch(() => { loaded = null; });
  }
  return loaded;
}
export async function processPCM(channels, sampleRate, { cancelled = () => false, load = runtime } = {}) {
  const started = performance.now(), cached = !!loaded;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !Array.isArray(channels) ||
      channels.length < 1 || channels.length > 2 || !channels[0]?.length || channels.some(c => !(c instanceof Float32Array) || c.length !== channels[0].length) ||
      channels[0].length * channels.length * 4 > 32 * 1024 ** 2) throw Error('noise.invalid');
  for (const channel of channels) for (const sample of channel) if (!Number.isFinite(sample)) throw Error('noise.invalid');
  const validatedAt = performance.now(), api = await load();
  if (api.frameSize !== FRAME) throw Error('noise.engineMismatch');
  const loadedAt = performance.now(), states = [], output = channels.map(c => new Float32Array(c.length));
  let computeMs = 0, neuralMs = 0, emitted = 0, frames = 0, stateMs = 0;
  try {
    for (let c = 0; c < channels.length; c++) states.push(api.createDenoiseState());
    stateMs = performance.now() - loadedAt;
    const inputKernel = new SincKernel(sampleRate, RATE), resampler = new OutputResampler(RATE, sampleRate, channels.length, channels[0].length);
    const nativeCount = Math.ceil(channels[0].length * RATE / sampleRate);
    const totalFrames = Math.ceil((nativeCount + DELAY + 64) / FRAME);
    let discard = DELAY;
    const emit = pcm => { pcm.forEach((c, i) => output[i].set(c, emitted)); emitted += pcm[0].length; };
    for (let p = 0; p < totalFrames * FRAME; p += FRAME * 32) {
      if (cancelled()) throw new DOMException('Noise processing cancelled', 'AbortError');
      const count = Math.min(FRAME * 32, totalFrames * FRAME - p), block = channels.map(() => new Float32Array(count));
      const tick = performance.now();
      for (let q = 0; q < count; q += FRAME) {
        for (let c = 0; c < channels.length; c++) {
          const frame = new Float32Array(FRAME);
          for (let j = 0; j < FRAME; j++) {
            const at = (p + q + j) * sampleRate / RATE;
            frame[j] = at < channels[c].length ? inputKernel.at(channels[c], at) * 32768 : 0;
            if (!Number.isFinite(frame[j])) throw Error('noise.invalid');
          }
          const neuralAt = performance.now(); states[c].processFrame(frame); neuralMs += performance.now() - neuralAt;
          for (let j = 0; j < FRAME; j++) {
            const sample = frame[j] / 32768;
            if (!Number.isFinite(sample)) throw Error('noise.invalidOutput');
            block[c][q + j] = sample;
          }
        }
        frames++;
      }
      computeMs += performance.now() - tick;
      const drop = Math.min(discard, count); discard -= drop;
      resampler.append(block.map(c => c.subarray(drop))); emit(resampler.pull());
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    emit(resampler.pull(true));
    if (emitted !== channels[0].length || output.some(c => c.some(x => !Number.isFinite(x)))) throw Error('noise.invalidOutput');
    return { channels: output, metrics: { cached, validationMs: validatedAt - started, initMs: loadedAt - validatedAt, stateMs, neuralMs, computeMs, totalMs: performance.now() - started,
      frames, samples: emitted, sampleRate, channels: channels.length, delay: DELAY, statesCreated: states.length,
      memoryBytes: api.rnnoiseModule?.HEAPF32?.buffer.byteLength ?? null } };
  } finally { for (const state of states) state.destroy(); }
}
