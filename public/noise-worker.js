importScripts('noise-model.js', 'noise-dsp.js');
self.onmessage = ({ data }) => {
  try {
    const { kind, pcm, sampleRate, profile, strength } = data;
    if (!(pcm instanceof Float32Array) || pcm.length > sampleRate * 1800 || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw Error('noise.invalid');
    let result;
    if (kind === 'calibrate') result = DublineNoiseDsp.calibrate(pcm, sampleRate);
    else {
      if (!DublineNoiseModel.validProfile(profile) || !Number.isFinite(strength) || strength < 0 || strength > 1) throw Error('noise.invalid');
      const iterator = DublineNoiseDsp.process(pcm, sampleRate, profile, strength); let step; do { step = iterator.next(); } while (!step.done); result = step.value;
    }
    self.postMessage({ result }, result instanceof Float32Array ? [result.buffer] : []);
  } catch (error) { self.postMessage({ error: error.message }); }
};
