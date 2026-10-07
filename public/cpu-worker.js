// CPU-only worker; room mutations and the audio graph stay on the main thread.
self.window = self;
importScripts('audio-fx.js');
self.onmessage = async ({ data }) => {
  const { id, scope, kind, channels, rate, sampleRate, bytes, semitones } = data;
  try {
    let result;
    if (kind === 'stretch') {
      if (![1.25, 1.5, 2, 3, 4].includes(rate) || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !Array.isArray(channels) || channels.length > 8) throw new Error('Invalid PCM job');
      result = channels.map(channel => new Float32Array(wsolaStretch(new Float32Array(channel), 1 / rate, sampleRate)));
    } else if (kind === 'pitch') {
      if (!Number.isFinite(semitones) || semitones < -24 || semitones > 24 || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !Array.isArray(channels) || channels.length !== 1) throw new Error('Invalid pitch job');
      result = [pitchShiftSamples(new Float32Array(channels[0]), semitones, sampleRate)];
    } else if (kind === 'peaks') {
      if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !Array.isArray(channels) || !channels.length || channels.length > 8) throw Error('Invalid waveform PCM');
      const bucket = Math.max(1, Math.floor(sampleRate / 100));
      const pcm = channels.map(channel => new Float32Array(channel)), count = Math.ceil(pcm[0].length / bucket);
      const peaks = new Float32Array(count); let top = .1;
      for (const data of pcm) for (let i = 0; i < count; i++) {
        let peak = peaks[i];
        for (let j = i * bucket, end = Math.min(data.length, (i + 1) * bucket); j < end; j++) peak = Math.max(peak, Math.abs(data[j]));
        peaks[i] = peak; top = Math.max(top, peak);
      }
      for (let i = 0; i < count; i++) peaks[i] /= top;
      result = [peaks];
    } else if (kind === 'sha256') {
      result = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    } else throw new Error('Unknown CPU job');
    self.postMessage({ id, scope, result }, Array.isArray(result) ? result.map(channel => channel.buffer) : []);
  } catch (error) { self.postMessage({ id, scope, error: error.message }); }
};
