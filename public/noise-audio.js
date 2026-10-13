(() => {
  const queue = []; let active = null, worker = null;
  const stats = { completed: 0, cancelled: 0, fallback: 0, peakQueue: 0 };
  const abortError = () => new DOMException('Noise processing cancelled', 'AbortError');
  function pump() {
    if (active || !queue.length) return;
    const job = queue.shift(); active = job;
    job.timer = setTimeout(() => job.finish(new Error('noise.timeout')), 60000);
    try {
      if (typeof Worker === 'undefined') throw Error('No worker');
      worker ||= new Worker('/noise-worker.js');
      worker.onmessage = ({ data }) => job.finish(data.error ? new Error(data.error) : null, data.result);
      worker.onerror = () => { worker?.terminate(); worker = null; fallback(job); };
      worker.postMessage(job.payload, [job.payload.pcm.buffer]);
    } catch { fallback(job); }
  }
  async function fallback(job) {
    if (job.fallback || active !== job) return; job.fallback = true; stats.fallback++;
    try {
      // The fallback copy survives failed transfer/worker startup.
      const { kind, sampleRate, profile, strength } = job.payload, pcm = job.backup;
      let result;
      if (kind === 'calibrate') { await new Promise(resolve => setTimeout(resolve, 0)); result = DublineNoiseDsp.calibrate(pcm, sampleRate); }
      else {
        const iterator = DublineNoiseDsp.process(pcm, sampleRate, profile, strength); let step;
        do { if (active !== job || job.signal?.aborted) throw abortError(); step = iterator.next(); if (!step.done) await new Promise(resolve => setTimeout(resolve, 0)); } while (!step.done);
        result = step.value;
      }
      job.finish(null, result);
    } catch (error) { job.finish(error); }
  }
  function run(payload, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    const pendingBytes = queue.reduce((sum, job) => sum + job.backup.byteLength, active?.backup?.byteLength || 0);
    if (payload.pcm.byteLength > 32 * 1024 ** 2 || pendingBytes + payload.pcm.byteLength > 64 * 1024 ** 2 || queue.length >= 16) return Promise.reject(Error('noise.busy'));
    return new Promise((resolve, reject) => {
      const job = { payload, signal, backup: new Float32Array(payload.pcm) };
      const abort = () => {
        stats.cancelled++;
        if (active === job) { worker?.terminate(); worker = null; }
        const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
        job.finish(abortError());
      };
      job.finish = (error, result) => {
        if (job.finished) return; job.finished = true;
        clearTimeout(job.timer); signal?.removeEventListener('abort', abort); job.backup = null;
        if (active === job) { active = null; if (error && !job.fallback) { worker?.terminate(); worker = null; } }
        if (error) reject(error); else { stats.completed++; resolve(result); } pump();
      };
      signal?.addEventListener('abort', abort, { once: true }); queue.push(job); stats.peakQueue = Math.max(stats.peakQueue, queue.length); pump();
    });
  }
  let lastWarning = 0;
  async function clean(buffer, setting, signal, strict = false) {
    if (!setting) return buffer;
    try {
      if (setting.missing || !DublineNoiseModel.validProfile(setting.profile)) throw Error('noise.profileMissing');
      if (buffer.length * buffer.numberOfChannels * 4 > 32 * 1024 ** 2) throw Error('noise.busy');
      const result = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: buffer.length, sampleRate: buffer.sampleRate });
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const pcm = new Float32Array(buffer.getChannelData(channel));
        const samples = await run({ kind: 'clean', pcm, sampleRate: buffer.sampleRate, profile: setting.profile, strength: setting.strength }, signal);
        result.copyToChannel(samples, channel);
      }
      if (signal?.aborted) throw abortError(); return result;
    } catch (error) {
      if (error.name === 'AbortError' || strict) throw error;
      if (Date.now() - lastWarning > 5000) { lastWarning = Date.now(); window.showToast?.(t('noise.fallback')); }
      return buffer;
    }
  }
  function cancelAll() { const pending = queue.splice(0); worker?.terminate(); worker = null; active?.finish(abortError()); for (const job of pending) job.finish(abortError()); }
  window.DublineNoiseAudio = { run, clean, cancelAll, stats: () => ({ ...stats, queued: queue.length, active: !!active }) };
  window.addEventListener('pagehide', cancelAll);
})();
