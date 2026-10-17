(() => {
  const queue = [], cache = new WeakMap(); let worker = null, active = null, sequence = 0, bytes = 0;
  const stats = { completed: 0, milliseconds: 0, peakBytes: 0 };
  function pump() {
    if (active || !queue.length) return; const job = queue.shift(); active = job;
    try { worker ||= new Worker('/speech-worker.js'); const current = worker;
      current.onmessage = ({ data }) => { if (current !== worker || job !== active || data.id !== job.id) return; finish(data.error ? Error(data.error) : null, data.result, data.milliseconds); };
      current.onerror = () => finish(Error('level.unavailable')); job.timer = setTimeout(() => finish(Error('level.unavailable')), 30000);
      current.postMessage({ id: job.id, kind: job.kind, channels: job.channels, rate: job.rate, bounds: job.bounds }, job.channels.map(channel => channel.buffer)); job.channels = null;
    } catch { finish(Error('level.unavailable')); }
  }
  function finish(error, result, milliseconds = 0) {
    const job = active; if (!job) return; active = null; clearTimeout(job.timer); bytes -= job.bytes;
    if (error) { worker?.terminate(); worker = null; job.reject(error); } else { stats.completed++; stats.milliseconds += milliseconds; job.resolve(result); } pump();
  }
  function measure(buffer, bounds, kind = 'level', signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    let entries = cache.get(buffer); if (!entries) { entries = new Map(); cache.set(buffer, entries); }
    const key = JSON.stringify([kind, bounds?.from, bounds?.to, DublineSpeechModel.VERSION]);
    if (!entries.has(key)) {
      const from = Math.max(0, Math.min(buffer.length - 1, Math.round((bounds?.from || 0) * buffer.sampleRate))), to = Math.max(from + 1, Math.min(buffer.length, Math.round((bounds?.to ?? buffer.duration) * buffer.sampleRate)));
      const size = (to - from) * buffer.numberOfChannels * 4;
      if (!size || size > 32 * 1024 ** 2 || bytes + size > 64 * 1024 ** 2 || queue.length >= 16) return Promise.reject(Error('level.busy'));
      const entry = { result: null }; entry.promise = new Promise((resolve, reject) => {
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => new Float32Array(buffer.getChannelData(channel).subarray(from, to)));
        const job = { id: ++sequence, channels, rate: buffer.sampleRate, bounds: {}, kind, bytes: size, resolve: result => { entry.result = result; resolve(result); }, reject }; bytes += size; stats.peakBytes = Math.max(stats.peakBytes, bytes); queue.push(job); pump();
      }).catch(error => { if (entries.get(key) === entry) entries.delete(key); throw error; }); entries.set(key, entry); if (entries.size > 8) entries.delete(entries.keys().next().value);
    }
    const entry = entries.get(key); const promise = entry.promise.then(result => { if (!entries.has(key)) { entries.set(key, entry); if (entries.size > 8) entries.delete(entries.keys().next().value); } return result; }); if (!signal) return promise;
    return new Promise((resolve, reject) => { const abort = () => reject(new DOMException('Cancelled', 'AbortError')); signal.addEventListener('abort', abort, { once: true }); promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)); });
  }
  function factor(buffer, bounds) { const result = cache.get(buffer)?.get(JSON.stringify(['level', bounds?.from, bounds?.to, DublineSpeechModel.VERSION]))?.result; return DublineSpeechModel.gain(result); }
  window.DublineSpeechAnalysis = { measure, factor, stats: () => ({ ...stats, bytes, queued: queue.length, active: !!active }) };
  window.addEventListener('pagehide', () => { const abandoned = queue.splice(0); worker?.terminate(); worker = null; if (active) finish(new DOMException('Cancelled', 'AbortError')); for (const job of abandoned) { bytes -= job.bytes; job.reject(new DOMException('Cancelled', 'AbortError')); } });
})();
