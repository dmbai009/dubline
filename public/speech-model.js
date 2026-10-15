(function(root) {
  const VERSION = 1, WARNINGS = ['clipped', 'empty', 'quiet', 'longPause', 'startCut', 'endCut'];
  const finite = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
  function validQuality(value) {
    return value === null || value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['version', 'duration', 'peak', 'rms', 'silenceRatio', 'clippedSamples', 'warnings'].includes(key)) && value.version === VERSION && finite(value.duration, 0, 86400) && finite(value.peak, 0, 32) && finite(value.rms, 0, 32) && finite(value.silenceRatio, 0, 1) && Number.isSafeInteger(value.clippedSamples) && value.clippedSamples >= 0 && Array.isArray(value.warnings) && value.warnings.length <= WARNINGS.length && new Set(value.warnings).size === value.warnings.length && value.warnings.every(key => WARNINGS.includes(key));
  }
  function range(channels, rate, bounds = {}) {
    if (!Array.isArray(channels) || ![1, 2].includes(channels.length) || !finite(rate, 8000, 192000) || !channels[0]?.length || channels.some(channel => !(channel instanceof Float32Array) || channel.length !== channels[0].length)) throw Error('level.invalid');
    const from = Math.max(0, Math.min(channels[0].length - 1, Math.round((bounds.from || 0) * rate))), to = Math.max(from + 1, Math.min(channels[0].length, Math.round((bounds.to ?? channels[0].length / rate) * rate)));
    return { from, to, length: to - from };
  }
  function quality(channels, rate, bounds) {
    const { from, to, length } = range(channels, rate, bounds), hop = Math.max(1, Math.round(rate * .02)), frames = [];
    let peak = 0, energy = 0, clippedSamples = 0, accumulated = 0, count = 0;
    for (let i = from; i < to; i++) {
      let squared = 0; for (const channel of channels) { const value = channel[i]; if (!Number.isFinite(value)) throw Error('level.invalid'); peak = Math.max(peak, Math.abs(value)); squared += value * value; if (Math.abs(value) >= .9995) clippedSamples++; }
      energy += squared; accumulated += squared; count++;
      if (count === hop || i === to - 1) { frames.push(Math.sqrt(accumulated / count / channels.length)); count = 0; accumulated = 0; }
    }
    const duration = length / rate, rms = Math.sqrt(energy / length / channels.length), silenceRatio = frames.filter(value => value < .0003).length / frames.length, warnings = [];
    if (clippedSamples >= Math.max(8, length * channels.length * .002)) warnings.push('clipped');
    if (duration >= .2 && peak < .0001 && rms < .00005) warnings.push('empty');
    else if (duration >= .5 && rms < .0006 && peak >= .0001 && peak < .003) warnings.push('quiet');
    let longest = 0, run = 0; const active = frames.map((value, index) => value > .005 ? index : -1).filter(index => index >= 0);
    if (active.length) for (let i = active[0]; i <= active.at(-1); i++) { run = frames[i] < .0003 ? run + 1 : 0; longest = Math.max(longest, run * .02); }
    if (duration >= 12 && longest > Math.max(8, duration * .65)) warnings.push('longPause');
    if (duration >= .4 && frames.length >= 4 && frames[0] > .015 && frames[1] > .015) warnings.push('startCut');
    if (duration >= .4 && frames.length >= 4 && frames.at(-1) > .015 && frames.at(-2) > .015) warnings.push('endCut');
    return { version: VERSION, duration, peak, rms, silenceRatio, clippedSamples, warnings };
  }
  // K weighting and two-stage gating from ITU-R BS.1770. Short takes use
  // one complete shorter block; this adaptation is not a certified meter.
  function coefficients(rate) {
    const k = Math.tan(Math.PI * 1681.974450955532 / rate), q = .7071752369554193, high = 10 ** (3.99984385397 / 20), middle = high ** .499666774155, divisor = 1 + k / q + k * k;
    const shelf = [(high + middle * k / q + k * k) / divisor, 2 * (k * k - high) / divisor, (high - middle * k / q + k * k) / divisor, 2 * (k * k - 1) / divisor, (1 - k / q + k * k) / divisor];
    const h = Math.tan(Math.PI * 38.13547087614 / rate), d = 1 + h / .5003270373253953 + h * h;
    return [shelf, [1, -2, 1, 2 * (h * h - 1) / d, (1 - h / .5003270373253953 + h * h) / d]];
  }
  // BS.1770 Annex 2: four phases of the 48-tap interpolating FIR.
  const firstHalf = [
    [.001708984375, -.0291748046875, -.0189208984375, -.00830078125],
    [.010986328125, .029296875, .0330810546875, .014892578125],
    [-.0196533203125, -.0517578125, -.0582275390625, -.026611328125],
    [.033203125, .089111328125, .1015625, .047607421875],
    [-.0594482421875, -.16650390625, -.2003173828125, -.102294921875],
    [.1373291015625, .465087890625, .77978515625, .97216796875]
  ];
  const peakRows = [...firstHalf, ...firstHalf.slice().reverse().map(row => row.slice().reverse())], phases = [0, 1, 2, 3].map(phase => peakRows.map(row => row[phase]));
  // Conservative periodicity check: unvoiced/ambiguous material is never boosted.
  // This is not speech recognition and cannot identify meaning or acting quality.
  function voiced(channels, rate, from, to) {
    const step = Math.max(1, Math.round(rate / 12000)), effectiveRate = rate / step, size = Math.min(Math.floor((to - from) / step), Math.round(effectiveRate * .04));
    if (size < effectiveRate * .02) return false;
    const frameCount = Math.min(8, Math.max(1, Math.floor((to - from) / (size * step))));
    for (let frame = 0; frame < frameCount; frame++) {
      const begin = from + Math.floor((to - from - size * step) * frame / Math.max(1, frameCount - 1)), samples = new Float64Array(size); let mean = 0, energy = 0;
      for (let i = 0; i < size; i++) { samples[i] = channels.reduce((sum, channel) => sum + channel[begin + i * step], 0) / channels.length; mean += samples[i]; } mean /= size;
      for (let i = 0; i < size; i++) { samples[i] -= mean; energy += samples[i] * samples[i]; }
      if (energy < size * .000001) continue;
      const minimum = Math.round(effectiveRate / 400); let previous = -2, beforePrevious = -2;
      for (let lag = minimum; lag <= Math.round(effectiveRate / 65); lag++) { let product = 0, left = 0, right = 0; for (let i = lag; i < size; i++) { product += samples[i] * samples[i - lag]; left += samples[i] ** 2; right += samples[i - lag] ** 2; } const correlation = product / Math.sqrt(left * right || 1); if (lag > minimum + 1 && previous > .5 && previous >= beforePrevious && previous > correlation) return true; beforePrevious = previous; previous = correlation; }
    }
    return false;
  }
  function level(channels, rate, bounds) {
    const { from, to, length } = range(channels, rate, bounds), filters = coefficients(rate), states = channels.map(() => [[0, 0], [0, 0]]), hop = Math.round(rate * .1), blocks = [];
    let part = 0, count = 0, total = 0, peak = 0;
    for (let i = from; i < to; i++) {
      let energy = 0;
      for (let c = 0; c < channels.length; c++) {
        let value = channels[c][i]; if (!Number.isFinite(value)) throw Error('level.invalid'); peak = Math.max(peak, Math.abs(value));
        for (let stage = 0; stage < 2; stage++) { const [b0, b1, b2, a1, a2] = filters[stage], state = states[c][stage], output = b0 * value + state[0]; state[0] = b1 * value - a1 * output + state[1]; state[1] = b2 * value - a2 * output; value = output; }
        energy += value * value;
      }
      part += energy; total += energy; if (++count === hop) { blocks.push(part / count); count = 0; part = 0; }
    }
    const energies = length < 4 * hop ? [total / length] : Array.from({ length: blocks.length - 3 }, (_, i) => (blocks[i] + blocks[i + 1] + blocks[i + 2] + blocks[i + 3]) / 4), loudness = energy => energy > 0 ? -.691 + 10 * Math.log10(energy) : -Infinity;
    const absolute = energies.filter(energy => loudness(energy) > -70), preliminary = absolute.length ? loudness(absolute.reduce((sum, value) => sum + value, 0) / absolute.length) : -Infinity;
    const gated = absolute.filter(energy => loudness(energy) > preliminary - 10), lufs = gated.length ? loudness(gated.reduce((sum, value) => sum + value, 0) / gated.length) : null;
    // Four-times bandlimited peak estimate, including the actual samples.
    let truePeak = peak;
    for (const channel of channels) for (let i = from; i < to + 12; i++) for (const taps of phases) { let value = 0; for (let tap = 0; tap < taps.length; tap++) value += (i - tap >= from && i - tap < to ? channel[i - tap] : 0) * taps[tap]; truePeak = Math.max(truePeak, Math.abs(value)); }
    return { version: VERSION, lufs, peak, truePeak, duration: length / rate, channels: channels.length, voiced: voiced(channels, rate, from, to) };
  }
  function gain(measurement) {
    if (!measurement) return 1;
    if (measurement.lufs == null || measurement.duration < .12 || measurement.lufs < -40 || measurement.peak < .006) return Math.min(1, .8 / Math.max(.000001, measurement.truePeak || 0));
    const target = -20 - (measurement.channels === 1 ? 10 * Math.log10(2) : 0), correction = Math.max(-6, Math.min(6, target - measurement.lufs));
    return Math.min(measurement.voiced === false && correction > 0 ? 1 : 10 ** (correction / 20), .8 / Math.max(.000001, measurement.truePeak));
  }
  const api = { VERSION, WARNINGS, validQuality, quality, coefficients, level, gain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineSpeechModel = api;
})(typeof window === 'undefined' ? globalThis : window);
