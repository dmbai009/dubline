(() => {
  const metadata = DublineLocalDatabase.store('mediaCacheMetadata'), chunks = DublineLocalDatabase.store('mediaCacheChunks');
  const pins = new Map();
  const sha = async data => {
    if (!window.crypto?.subtle) return null;
    if (window.DublineCpuJobs && data.byteLength <= 1024 * 1024) {
      const bytes = data instanceof ArrayBuffer ? data.slice(0) : new Uint8Array(data).buffer;
      try { return await window.DublineCpuJobs.run({ kind: 'sha256', bytes }, [bytes]); }
      catch (error) { if (error.message === 'Stale CPU job') throw error; window.DublineCpuJobs.noteFallback(); }
    }
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  };
  function valid(m) {
    return m?.layoutVersion === 1 && m.chunkSize === 256 * 1024 && Number.isSafeInteger(m.size) && m.size > 0 &&
      typeof m.sha256 === 'string' && /^[a-f0-9]{64}$/.test(m.sha256) && m.id === `${m.sha256}:${m.size}:${m.chunkSize}:1` &&
      Array.isArray(m.chunks) && m.chunks.length === Math.ceil(m.size / m.chunkSize) && m.chunks.length <= 32768 && m.chunks.every(value => /^[a-f0-9]{64}$/.test(value));
  }
  function expected(m, index) { return Math.min(m.chunkSize, m.size - index * m.chunkSize); }
  async function verify(m, index, bytes) {
    return valid(m) && Number.isInteger(index) && index >= 0 && index < m.chunks.length && bytes?.byteLength === expected(m, index) && await sha(bytes) === m.chunks[index];
  }
  function transaction(names, work) {
    return DublineLocalDatabase.open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(names, 'readwrite'); work(tx);
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || new Error('Media cache transaction failed'));
    }));
  }
  async function invalidate(m) {
    if (!valid(m)) return;
    await transaction(['mediaCacheMetadata', 'mediaCacheChunks'], tx => {
      tx.objectStore('mediaCacheMetadata').delete(m.id);
      const table = tx.objectStore('mediaCacheChunks');
      for (let index = 0; index < m.chunks.length; index++) table.delete(`${m.id}/${index}`);
    });
  }
  async function load(m) {
    if (!valid(m) || !window.crypto?.subtle) return [];
    try {
      const record = await metadata.get(m.id);
      if (!record || !valid(record.manifest) || JSON.stringify(record.manifest.chunks) !== JSON.stringify(m.chunks)) return [];
      const result = new Array(m.chunks.length);
      const stored = Array.isArray(record.verified) ? record.verified.filter(index => Number.isInteger(index) && index >= 0 && index < m.chunks.length) : [];
      for (let start = 0; start < stored.length; start += 8) await Promise.all(stored.slice(start, start + 8).map(async index => {
        const chunk = await chunks.get(`${m.id}/${index}`);
        if (chunk && await verify(m, index, chunk.bytes)) result[index] = chunk.bytes;
        else await chunks.remove(`${m.id}/${index}`);
      }));
      const verified = result.flatMap((bytes, index) => bytes ? [index] : []);
      await metadata.put({ id: m.id, manifest: m, verified, bytes: verified.reduce((sum, index) => sum + expected(m, index), 0), usedAt: Date.now() });
      if (verified.length === m.chunks.length && await sha(await new Blob(result).arrayBuffer()) !== m.sha256) { await invalidate(m); return []; }
      return result;
    } catch (error) { console.info('[DubLine] Persistent media cache unavailable; using memory:', error.message); return []; }
  }
  async function put(m, index, bytes) {
    if (!await verify(m, index, bytes)) return false;
    try {
      await transaction(['mediaCacheMetadata', 'mediaCacheChunks'], tx => {
        const table = tx.objectStore('mediaCacheMetadata'), request = table.get(m.id);
        request.onsuccess = () => {
          const previous = request.result;
          const verified = new Set(previous?.verified || []); verified.add(index);
          table.put({ id: m.id, manifest: m, verified: [...verified], bytes: [...verified].reduce((sum, i) => sum + expected(m, i), 0), usedAt: Date.now() });
          tx.objectStore('mediaCacheChunks').put({ id: `${m.id}/${index}`, bytes });
        };
      });
      return true;
    } catch (error) { console.info('[DubLine] Media cache write skipped:', error.message); return false; }
  }
  async function usage() { try { return (await metadata.all()).reduce((sum, record) => sum + (Number(record.bytes) || 0), 0); } catch { return 0; } }
  function limit() {
    try { const saved = Number(localStorage.getItem('dubline_cache_gb') ?? '2'); return Number.isFinite(saved) ? Math.max(.25, Math.min(20, saved)) * 1024 ** 3 : 2 * 1024 ** 3; } catch { return 2 * 1024 ** 3; }
  }
  async function prune() {
    try {
      const records = (await metadata.all()).sort((a, b) => a.usedAt - b.usedAt);
      let bytes = records.reduce((sum, record) => sum + (Number(record.bytes) || 0), 0);
      for (const record of records) {
        if (bytes <= limit()) break;
        if (pins.has(record.id) || !valid(record.manifest)) continue;
        await invalidate(record.manifest); bytes -= record.bytes;
      }
    } catch { /* Quota/private-mode fallback must not stop playback. */ }
  }
  function pin(id) { pins.set(id, (pins.get(id) || 0) + 1); let released = false; return () => { if (released) return; released = true; const count = pins.get(id) || 0; if (count <= 1) pins.delete(id); else pins.set(id, count - 1); prune(); }; }
  async function clear() {
    const records = await metadata.all();
    for (const record of records) if (!pins.has(record.id) && valid(record.manifest)) await invalidate(record.manifest);
  }
  window.DublineMediaCache = { valid, verify, load, put, pin, prune, usage, clear, sha, expected };
})();
