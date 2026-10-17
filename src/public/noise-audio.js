(() => {
  const queue = []; let active = null, worker = null, sequence = 0, queuedBytes = 0, lastWarning = 0;
  const stats = { completed: 0, cancelled: 0, fallback: 0, peakQueue: 0, peakBytes: 0, last: null };
  const priorities = { preview: 0, playback: 1, export: 2, prefetch: 3 };
  const abortError = () => new DOMException('Noise processing cancelled', 'AbortError');
  function pump() {
    if (active || !queue.length) return;
    queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
    const job = queue.shift(); active = job;
    job.timer = setTimeout(() => job.finish(new Error('noise.timeout')), 60000);
    try {
      if (typeof Worker === 'undefined') throw Error('noise.unavailable');
      worker ||= new Worker('/noise-worker.js', { type: 'module' });
      const current = worker;
      current.onmessage = ({ data }) => {
        if (worker !== current || active !== job || data.id !== job.id) return;
        job.finish(data.error ? new Error(data.error) : null, data.result);
      };
      current.onerror = () => { if (worker === current && active === job) job.finish(Error('noise.unavailable')); };
      current.postMessage({ id: job.id, ...job.payload }, job.payload.channels.map(channel => channel.buffer));
    } catch (error) { job.finish(error); }
  }
  function run(payload, signal, priority = 'playback', key = null) {
    if (signal?.aborted) return Promise.reject(abortError());
    const bytes = payload.channels?.reduce((sum, channel) => sum + channel.byteLength, 0) || 0;
    if (!bytes || bytes > 32 * 1024 ** 2 || queuedBytes + bytes > 64 * 1024 ** 2 || queue.length >= 16) return Promise.reject(Error('noise.busy'));
    return new Promise((resolve, reject) => {
      const job = { id: ++sequence, payload, signal, bytes, key, priority: priorities[priority] ?? 1 };
      const abort = () => { if (job.finished) return; stats.cancelled++; const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); job.finish(abortError()); };
      job.finish = (error, result) => {
        if (job.finished) return; job.finished = true;
        clearTimeout(job.timer); signal?.removeEventListener('abort', abort); queuedBytes -= bytes; job.payload = null;
        if (active === job) {
          active = null;
          if (worker) { worker.onmessage = null; worker.onerror = null; if (error) { worker.terminate(); worker = null; } }
        }
        if (error) reject(error); else { stats.completed++; stats.last = result.metrics; resolve(result); }
        pump();
      };
      signal?.addEventListener('abort', abort, { once: true }); queuedBytes += bytes; queue.push(job);
      stats.peakQueue = Math.max(stats.peakQueue, queue.length); stats.peakBytes = Math.max(stats.peakBytes, queuedBytes); pump();
    });
  }
  function promote(key, priority) { for (const job of queue) if (job.key === key) job.priority = Math.min(job.priority, priorities[priority] ?? 1); }
  async function wet(buffer, { signal, priority, key } = {}) {
    if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2 || buffer.length * buffer.numberOfChannels * 4 > 32 * 1024 ** 2) throw Error('noise.busy');
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => new Float32Array(buffer.getChannelData(c)));
    const result = await run({ channels, sampleRate: buffer.sampleRate }, signal, priority, key);
    if (signal?.aborted) throw abortError();
    if (!result || result.channels.length !== channels.length || result.channels.some(c => c.length !== buffer.length || c.some(x => !Number.isFinite(x)))) throw Error('noise.invalidOutput');
    const output = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: buffer.length, sampleRate: buffer.sampleRate });
    result.channels.forEach((channel, c) => output.copyToChannel(channel, c)); return output;
  }
  function mix(dry, processed, strength) {
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw Error('noise.invalid');
    if (!strength) return dry;
    if (!processed || dry.length !== processed.length || dry.sampleRate !== processed.sampleRate || dry.numberOfChannels !== processed.numberOfChannels) throw Error('noise.invalidOutput');
    if (strength === 1) return processed;
    const result = new AudioBuffer({ length: dry.length, sampleRate: dry.sampleRate, numberOfChannels: dry.numberOfChannels });
    for (let c = 0; c < dry.numberOfChannels; c++) {
      const a = dry.getChannelData(c), b = processed.getChannelData(c), out = result.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] = (1 - strength) * a[i] + strength * b[i];
    }
    return result;
  }
  function fallback(error) {
    if (error.name === 'AbortError') return;
    stats.fallback++;
    if (Date.now() - lastWarning > 5000) { lastWarning = Date.now(); window.showToast?.(window.DublineI18n?.t('noise.fallback') || 'Noise processing unavailable; playing the original.'); }
  }
  async function clean(buffer, setting, signal, strict = false) {
    if (!setting?.enabled || !setting.strength) return buffer;
    try { return mix(buffer, await wet(buffer, { signal }), setting.strength); }
    catch (error) { if (error.name === 'AbortError' || strict) throw error; fallback(error); return buffer; }
  }
  function cancelAll() {
    const pending = queue.splice(0); worker?.terminate(); worker = null;
    if (active) { stats.cancelled++; active.finish(abortError()); }
    for (const job of pending) { stats.cancelled++; job.finish(abortError()); }
  }
  window.DublineNoiseAudio = Object.freeze({ run, wet, mix, clean, fallback, promote, cancelAll,
    stats: () => ({ ...stats, queued: queue.length, active: !!active, queuedBytes }) });
  window.addEventListener('pagehide', cancelAll);
})();
