(function(root) {
  // Compare active windows of this take with the same windows after processing.
  // One fixed gain preserves dynamics; tails and silence cannot drive boosting.
  function correction(reference, processed, sampleRate, from = 0, to = reference.length) {
    const start = Math.max(0, Math.floor(from)), end = Math.min(reference.length, Math.ceil(to));
    const window = Math.max(1, Math.round(sampleRate * .02)), frames = []; let maximum = 0;
    for (let at = start; at < end; at += window) {
      const stop = Math.min(end, at + window); let energy = 0;
      for (let i = at; i < stop; i++) energy += reference[i] ** 2;
      const rms = Math.sqrt(energy / (stop - at)); maximum = Math.max(maximum, rms); frames.push({ at, stop, rms });
    }
    const gate = Math.max(1e-6, maximum * .15); let input = 0, output = 0, count = 0;
    for (const frame of frames) if (frame.rms >= gate) for (let i = frame.at; i < frame.stop; i++) {
      input += reference[i] ** 2; output += (processed[i] || 0) ** 2; count++;
    }
    const dryRms = count ? Math.sqrt(input / count) : 0, wetRms = count ? Math.sqrt(output / count) : 0;
    const gain = wetRms > 1e-9 && dryRms > 0 ? Math.min(dryRms < .001 ? 1 : 2, dryRms / wetRms) : 1;
    let peak = 0; for (const sample of processed) peak = Math.max(peak, Math.abs(sample));
    return { gain: Math.min(gain, peak > .95 ? .95 / peak : Infinity), dryRms, wetRms, count };
  }
  const api = Object.freeze({ correction });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineVoiceLevel = api;
})(typeof window === 'undefined' ? globalThis : window);
