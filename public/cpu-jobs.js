(() => {
  const slots = [], queue = [];
  let sequence = 0, unavailable = typeof Worker === 'undefined';
  const currentScope = () => typeof session !== 'undefined' ? session?.activeSessionId : null;
  const counters = { completed: 0, cancelled: 0, fallback: 0, queuePeak: 0 };
  function pump() {
    for (const slot of slots) {
      if (slot.job || !queue.length) continue;
      const job = queue.shift();
      if (job.scope && currentScope() && job.scope !== currentScope()) { job.reject(new Error('Stale CPU job')); counters.cancelled++; continue; }
      slot.job = job;
      slot.timer = setTimeout(() => fail(slot, new Error('CPU job timeout')), 60000);
      try { slot.worker.postMessage({ id: job.id, scope: job.scope, ...job.payload }, job.transfer); }
      catch (error) { fail(slot, error); }
    }
  }
  function fail(slot, error) {
    clearTimeout(slot.timer); slot.job?.reject(error); slot.job = null;
    slot.worker.terminate(); slots.splice(slots.indexOf(slot), 1); unavailable = true;
    while (queue.length) queue.shift().reject(error);
  }
  function makeSlot() {
    const worker = new Worker('/cpu-worker.js'), slot = { worker, job: null };
    worker.onmessage = ({ data }) => {
      const job = slot.job;
      if (!job || data.id !== job.id || data.scope !== job.scope) return;
      clearTimeout(slot.timer); slot.job = null;
      if (job.scope && currentScope() && job.scope !== currentScope()) { job.reject(new Error('Stale CPU job')); counters.cancelled++; }
      else if (data.error) job.reject(new Error(data.error));
      else { job.resolve(data.result); counters.completed++; }
      pump();
    };
    worker.onerror = () => fail(slot, new Error('CPU worker unavailable'));
    slots.push(slot);
  }
  function run(payload, transfer = [], scope = currentScope()) {
    if (unavailable) return Promise.reject(new Error('CPU worker unavailable'));
    if (queue.length >= 16) return Promise.reject(new Error('CPU queue full'));
    try { while (slots.length < 2) makeSlot(); } catch { unavailable = true; return Promise.reject(new Error('CPU worker unavailable')); }
    return new Promise((resolve, reject) => {
      queue.push({ id: ++sequence, payload, transfer, scope, resolve, reject });
      counters.queuePeak = Math.max(counters.queuePeak, queue.length); pump();
    });
  }
  function cancelStale() {
    const scope = currentScope();
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index].scope && queue[index].scope !== scope) { queue.splice(index, 1)[0].reject(new Error('Stale CPU job')); counters.cancelled++; }
    for (const slot of [...slots]) if (slot.job?.scope && slot.job.scope !== scope) {
      clearTimeout(slot.timer); slot.job.reject(new Error('Stale CPU job')); slot.worker.terminate(); slots.splice(slots.indexOf(slot), 1); counters.cancelled++;
    }
    pump();
  }
  window.DublineCpuJobs = { run, cancelStale, counters, noteFallback: () => counters.fallback++, stats: () => ({ ...counters, queued: queue.length, active: slots.filter(slot => slot.job).length }) };
})();
