// Profile-based STFT Wiener suppression. No gate, silence learner or gain normalization.
(function(root) {
  'use strict';
  const N = 1024, HOP = 256, BINS = 513;
  const window = Float64Array.from({ length: N }, (_, i) => Math.sqrt(.5 - .5 * Math.cos(2 * Math.PI * i / N)));
  function fft(re, im, inverse = false) {
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let size = 2; size <= N; size *= 2) {
      const angle = (inverse ? 2 : -2) * Math.PI / size, wr0 = Math.cos(angle), wi0 = Math.sin(angle);
      for (let base = 0; base < N; base += size) {
        let wr = 1, wi = 0;
        for (let j = 0; j < size / 2; j++) {
          const a = base + j, b = a + size / 2, tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const next = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = next;
        }
      }
    }
    if (inverse) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }
  function frame(pcm, at, re, im) {
    for (let i = 0; i < N; i++) { re[i] = (pcm[at + i] || 0) * window[i]; im[i] = 0; }
    fft(re, im);
  }
  function calibrate(pcm, sampleRate) {
    if (pcm.length < sampleRate * 5.9) throw Error('noise.incomplete');
    let peak = 0, energy = 0, clipped = 0;
    for (const value of pcm) { if (!Number.isFinite(value)) throw Error('noise.invalid'); peak = Math.max(peak, Math.abs(value)); energy += value * value; if (Math.abs(value) >= .99) clipped++; }
    if (peak < 1e-6 || energy / pcm.length < 1e-14) throw Error('noise.noSignal');
    if (clipped > 0) throw Error('noise.clipping');
    const powers = Array.from({ length: BINS }, () => []), levels = [], spectra = [], re = new Float64Array(N), im = new Float64Array(N);
    // At most ~1125 frames at 48 kHz, bounded six-second calibration only.
    for (let at = 0; at + N <= pcm.length; at += Math.max(HOP, Math.round(sampleRate / 200))) {
      frame(pcm, at, re, im); let level = 0; const bands = new Float64Array(16);
      for (let k = 0; k < BINS; k++) { const p = re[k] * re[k] + im[k] * im[k]; powers[k].push(p); level += p; bands[Math.min(15, Math.floor(k / 32))] += p; }
      levels.push(level); spectra.push(bands);
    }
    const sorted = [...levels].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
    // Speech/transients usually violate stationarity. This is a conservative quality
    // check, not speech recognition: steady speech can still require human rejection.
    if (sorted[Math.floor(sorted.length * .95)] > median * 3.5 || sorted[Math.floor(sorted.length * .1)] * 5 < median) throw Error('noise.unstable');
    let flux = 0;
    for (let i = 1; i < spectra.length; i++) {
      const a = spectra[i], b = spectra[i - 1], sa = a.reduce((x, y) => x + y, 0), sb = b.reduce((x, y) => x + y, 0);
      flux += a.reduce((sum, value, k) => sum + Math.abs(value / sa - b[k] / sb), 0);
    }
    if (flux / Math.max(1, spectra.length - 1) > .55) throw Error('noise.speech');
    return { version: 1, fft: N, sampleRate, createdAt: Date.now(), power: powers.map(values => { values.sort((a, b) => a - b); return values[Math.floor(values.length * .6)]; }) };
  }
  function* process(pcm, sampleRate, profile, strength) {
    const result = new Float32Array(pcm.length);
    if (!strength) { result.set(pcm); return result; }
    let inputPeak = 0;
    for (const value of pcm) { if (!Number.isFinite(value)) throw Error('noise.invalid'); inputPeak = Math.max(inputPeak, Math.abs(value)); }
    const weights = new Float32Array(pcm.length), re = new Float64Array(N), im = new Float64Array(N), gains = new Float64Array(BINS).fill(1), targets = new Float64Array(BINS);
    const noise = Float64Array.from({ length: BINS }, (_, k) => {
      const position = k * sampleRate / profile.sampleRate, lo = Math.floor(position), fraction = position - lo;
      return ((profile.power[lo] || 0) * (1 - fraction) + (profile.power[lo + 1] || 0) * fraction) * profile.sampleRate / sampleRate;
    });
    const floor = Math.pow(10, -24 * strength / 20), sensitivity = .8 + strength * .7;
    let frames = 0;
    for (let at = -N + HOP; at < pcm.length; at += HOP) {
      frame(pcm, at, re, im);
      for (let k = 0; k < BINS; k++) {
        const power = re[k] * re[k] + im[k] * im[k];
        targets[k] = Math.max(floor, Math.sqrt(Math.max(0, 1 - sensitivity * noise[k] / Math.max(1e-20, power))));
      }
      for (let k = 0; k < BINS; k++) {
        const smooth = (targets[Math.max(0, k - 1)] + 2 * targets[k] + targets[Math.min(BINS - 1, k + 1)]) / 4;
        // Release suppression quickly when speech returns; introduce attenuation gently.
        gains[k] += (smooth - gains[k]) * (smooth > gains[k] ? .8 : .25);
        re[k] *= gains[k]; im[k] *= gains[k];
        if (k && k < N / 2) { re[N - k] *= gains[k]; im[N - k] *= gains[k]; }
      }
      fft(re, im, true);
      for (let i = 0; i < N; i++) { const j = at + i; if (j >= 0 && j < pcm.length) { result[j] += re[i] * window[i]; weights[j] += window[i] ** 2; } }
      if (++frames % 32 === 0) yield;
    }
    let peak = 0;
    for (let i = 0; i < result.length; i++) { result[i] /= Math.max(1e-12, weights[i]); peak = Math.max(peak, Math.abs(result[i])); }
    // Only prevent new overshoot; never amplify residual noise.
    const limit = Math.max(1, inputPeak);
    if (peak > limit) for (let i = 0; i < result.length; i++) result[i] *= limit / peak;
    return result;
  }
  const api = { calibrate, process };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineNoiseDsp = api;
})(typeof self === 'undefined' ? globalThis : self);
