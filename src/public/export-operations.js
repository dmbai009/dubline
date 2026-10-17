// Cancellable waits and bounded diagnostic metadata for one export, never media or credentials.
(function(root) {
  const numericFields = new Set(['timestamp', 'end', 'bytes', 'position', 'queue', 'duration']);
  const safe = data => Object.fromEntries(Object.entries(data || {}).filter(([key, value]) => numericFields.has(key) && Number.isFinite(value)));
  function create(signal, { now = () => performance.now(), warn = data => console.warn('Dubline export operation', data), timeoutMs = 180000 } = {}) {
    const pending = new Map(), recent = [], disposers = new Set();
    let serial = 0, failure, lastVideo = null;
    const snapshot = () => ({
      version: 1, lastVideo,
      pending: [...pending.values()].map(item => ({ ...item, waitingMs: Math.round(now() - item.started) })),
      lastCompleted: [...recent].reverse().find(item => item.state === 'done') || null,
      recent: recent.slice(-16)
    });
    const persist = () => {
      const data = snapshot();
      try { root.localStorage?.setItem('dubline_export_diagnostic', JSON.stringify(data)); } catch { /* Optional storage. */ }
      warn(data);
    };
    function check() { if (failure) throw failure; signal?.throwIfAborted(); }
    function dispose() {
      for (const fn of [...disposers]) { try { Promise.resolve(fn()).catch(() => {}); } catch { /* Already released. */ } }
      disposers.clear();
    }
    signal?.addEventListener('abort', dispose, { once: true });
    async function run(operation, fn, data, options = {}) {
      check();
      const id = ++serial, item = { operation, ...safe(data), started: now() }, deadline = options.timeoutMs ?? timeoutMs;
      pending.set(id, item);
      let timer, abort, reported = false, completed = false;
      try {
        const result = await new Promise((resolve, reject) => {
          abort = () => reject(signal.reason || new DOMException('Export cancelled', 'AbortError'));
          signal?.addEventListener('abort', abort, { once: true });
          if (Number.isFinite(deadline)) timer = setInterval(() => {
            const age = now() - item.started;
            if (age >= 15000 && !reported) { reported = true; persist(); }
            if (age >= deadline) {
              failure = Object.assign(Error('exportVideo.operationTimeout'), { code: 'export-timeout', operation });
              persist(); dispose(); reject(failure);
            }
          }, Math.min(1000, deadline));
          Promise.resolve().then(() => { check(); return fn(); }).then(value => {
            if (signal?.aborted || failure) { options.late?.(value); check(); }
            resolve(value);
          }, reject).catch(reject);
        });
        completed = true; return result;
      } finally {
        clearInterval(timer); signal?.removeEventListener('abort', abort); pending.delete(id);
        recent.push({ operation, ...safe(data), state: completed ? 'done' : signal?.aborted ? 'cancelled' : 'error', elapsed: Math.round(now() - item.started) });
        if (recent.length > 32) recent.shift();
      }
    }
    async function* iterate(iterator, operation, options = {}) {
      const cursor = iterator[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await run(operation, () => cursor.next(), null, { ...options, late: next => next?.value?.close?.() });
          if (next.done) return;
          yield next.value;
        }
      } finally {
        // A stalled iterator may also stall return(); its owned input is disposed separately.
        try { Promise.resolve(cursor.return?.()).catch(() => {}); } catch { /* Already closed. */ }
      }
    }
    return {
      run, iterate, check, snapshot, dispose,
      video: timestamp => { if (Number.isFinite(timestamp)) lastVideo = timestamp; },
      own: fn => { disposers.add(fn); return () => disposers.delete(fn); },
      close: () => { signal?.removeEventListener('abort', dispose); dispose(); }
    };
  }
  // Mediabunny 1.60 cancel() skips finalizing outputs and waits for an already-started
  // normal source close. Force the owned codec wrappers to release native codecs
  // first, including a flush that never settles. Keep this adapter covered by the
  // real WebCodecs cancellation test when upgrading the library.
  const abortedOutputs = new WeakSet();
  function abortOutput(output) {
    if (!output || output.state === 'finalized' || abortedOutputs.has(output)) return;
    abortedOutputs.add(output);
    for (const track of output.tracks || []) {
      try { Promise.resolve(track.source._flushAndClose?.(true)).catch(() => {}); } catch { /* Already closed. */ }
    }
    try { Promise.resolve(output.cancel()).catch(() => {}); } catch { /* Already cancelled. */ }
  }
  // Mediabunny aborts individual range requests as its read window moves. Keep
  // that signal: replacing it with the export signal leaves unread responses
  // open, exhausting Chromium's per-origin connections during long exports.
  function combineSignals(first, second) {
    if (!first || !second) return first || second;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([first, second]);
    // Keep older WebCodecs-capable browsers working. Listeners must live through
    // the response body, not just until fetch resolves its headers.
    const controller = new AbortController(), sources = [...new Set([first, second])];
    const listeners = sources.map(source => [source, () => controller.abort(source.reason)]);
    controller.signal.addEventListener('abort', () => {
      for (const [source, relay] of listeners) source.removeEventListener('abort', relay);
    }, { once: true });
    for (const [source, relay] of listeners) source.addEventListener('abort', relay, { once: true });
    for (const [source, relay] of listeners) if (source.aborted) { relay(); break; }
    return controller.signal;
  }
  function fetchSource(signal, fetchFn = (...args) => fetch(...args)) {
    return (url, options = {}) => fetchFn(url, {
      ...options,
      signal: combineSignals(options.signal, signal)
    });
  }
  const api = { create, abortOutput, fetchSource };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DublineExportOperations = api;
})(typeof window === 'undefined' ? globalThis : window);
