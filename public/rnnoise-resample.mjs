// Adapted from NoiseLab (MIT): symmetric 64-tap Blackman sinc, 1024 phases.
// Absolute sample coordinates preserve block boundaries and avoid timing drift.
export class SincKernel {
  constructor(inputRate, outputRate) {
    this.sameRate = inputRate === outputRate;
    if (this.sameRate) return;
    const cutoff = Math.min(1, outputRate / inputRate) * .94;
    this.table = Array.from({ length: 1024 }, (_, phase) => {
      const frac = phase / 1024, weights = new Float64Array(64); let sum = 0;
      for (let j = 0; j < 64; j++) {
        const d = j - 31 - frac, a = Math.PI * d * cutoff;
        const window = Math.abs(d) < 32 ? .42 + .5 * Math.cos(Math.PI * d / 32) + .08 * Math.cos(2 * Math.PI * d / 32) : 0;
        weights[j] = (Math.abs(a) < 1e-10 ? cutoff : cutoff * Math.sin(a) / a) * window; sum += weights[j];
      }
      for (let j = 0; j < 64; j++) weights[j] /= sum;
      return weights;
    });
  }
  at(array, position, base = 0) {
    if (this.sameRate) return array[Math.round(position) - base] || 0;
    const k = Math.floor(position), weights = this.table[Math.min(1023, Math.floor((position - k) * 1024))]; let sample = 0;
    for (let j = 0; j < 64; j++) sample += (array[k - 31 + j - base] || 0) * weights[j];
    return sample;
  }
}
export class OutputResampler {
  constructor(inputRate, outputRate, channels, outputFrames) {
    this.kernel = new SincKernel(inputRate, outputRate); this.ratio = inputRate / outputRate;
    this.limit = outputFrames; this.buffers = Array.from({ length: channels }, () => new Float32Array(0));
    this.base = 0; this.received = 0; this.emitted = 0;
  }
  append(pcm) {
    this.buffers = this.buffers.map((channel, i) => { const next = new Float32Array(channel.length + pcm[i].length); next.set(channel); next.set(pcm[i], channel.length); return next; });
    this.received += pcm[0].length;
  }
  pull(final = false) {
    const first = this.emitted;
    while (this.emitted < this.limit && (final || this.emitted * this.ratio + 33 < this.received)) this.emitted++;
    const out = this.buffers.map(channel => {
      const result = new Float32Array(this.emitted - first);
      for (let i = 0; i < result.length; i++) result[i] = this.kernel.at(channel, (first + i) * this.ratio, this.base);
      return result;
    });
    const discard = Math.max(0, Math.min(this.buffers[0].length, Math.floor(this.emitted * this.ratio) - 33 - this.base));
    this.buffers = this.buffers.map(channel => channel.slice(discard)); this.base += discard;
    return out;
  }
}
