(function(root) {
  function rangesFromIndexes(indexes) {
    const result = [];
    for (const index of [...new Set(indexes)].sort((a, b) => a - b)) {
      if (!Number.isSafeInteger(index) || index < 0) continue;
      const last = result.at(-1);
      if (last && last[1] + 1 === index) last[1] = index; else result.push([index, index]);
    }
    return result;
  }
  function validRanges(ranges, count) {
    if (!Array.isArray(ranges) || ranges.length > 4096 || !Number.isSafeInteger(count) || count < 1 || count > 32768) return false;
    let previous = -1;
    return ranges.every(range => Array.isArray(range) && range.length === 2 && Number.isInteger(range[0]) && Number.isInteger(range[1]) && range[0] >= 0 && range[1] >= range[0] && range[1] < count && range[0] > previous && (previous = range[1], true));
  }
  function contains(ranges, index) {
    let low = 0, high = ranges.length - 1;
    while (low <= high) { const middle = (low + high) >>> 1, range = ranges[middle];
      if (index < range[0]) high = middle - 1; else if (index > range[1]) low = middle + 1; else return true;
    }
    return false;
  }
  // Transport frames follow the priorities of their verified storage chunk.
  // Time-to-byte mapping is an estimate; exact decoder readiness is reported separately.
  class DownloadScheduler {
    constructor(chunks, now = () => performance.now(), random = Math.random) {
      this.chunks = chunks; this.now = now; this.random = random; this.peers = new Map();
      this.totalInflight = 0; this.globalLimit = 32; this.ranks = []; this.rankedAt = -Infinity;
    }
    availability(id, ranges) {
      if (!validRanges(ranges, this.chunks)) return false;
      const peer = this.peers.get(id) || { limit: 4, inflight: 0, rate: 0, latency: 250, adjustedAt: this.now() };
      peer.ranges = ranges; this.peers.set(id, peer); this.rankedAt = -Infinity; return true;
    }
    rank(position, duration) {
      const now = this.now(); if (now - this.rankedAt < 500) return;
      const timed = Number.isFinite(duration) && duration > 0;
      const start = timed ? Math.floor(Math.max(0, position - 5) / duration * this.chunks) : 0;
      const end = timed ? Math.min(this.chunks - 1, Math.ceil((position + 30) / duration * this.chunks)) : Math.min(this.chunks - 1, 7);
      const order = Array.from({ length: this.chunks }, (_, chunk) => ({ chunk,
        critical: chunk >= start && chunk <= end ? 0 : 1,
        copies: [...this.peers.values()].reduce((count, peer) => count + Number(contains(peer.ranges, chunk)), 0), tie: this.random() }));
      order.sort((a, b) => a.critical - b.critical || a.copies - b.copies || a.tie - b.tie);
      order.forEach((entry, rank) => { this.ranks[entry.chunk] = rank; }); this.rankedAt = now;
    }
    pick(id, pending, position, duration) {
      const peer = this.peers.get(id);
      if (!peer || peer.inflight >= peer.limit || this.totalInflight >= this.globalLimit) return -1;
      this.rank(position, duration); let choice = -1, best = Infinity;
      for (let at = 0; at < pending.length; at++) { const chunk = Math.floor(pending[at] / 4);
        if (contains(peer.ranges, chunk) && this.ranks[chunk] < best) { best = this.ranks[chunk]; choice = at; }
      }
      return choice;
    }
    started(id) { const peer = this.peers.get(id); if (peer) { peer.inflight++; this.totalInflight++; } }
    finished(id, bytes, elapsed, failed = false) {
      const peer = this.peers.get(id); if (!peer) return;
      if (peer.inflight) { peer.inflight--; this.totalInflight--; }
      if (failed) { peer.limit = Math.max(2, Math.floor(peer.limit / 2)); peer.adjustedAt = this.now(); return; }
      const latency = Math.max(1, elapsed), rate = bytes * 1000 / latency;
      peer.latency = peer.latency * 0.8 + latency * 0.2; peer.rate = peer.rate ? peer.rate * 0.8 + rate * 0.2 : rate;
      if (this.now() - peer.adjustedAt < 1000) return;
      const target = Math.max(2, Math.min(16, Math.ceil(peer.rate * Math.max(0.25, peer.latency / 1000) / 65536 * 2)));
      if (Math.abs(target - peer.limit) >= 2) peer.limit += Math.sign(target - peer.limit) * 2;
      peer.limit = Math.max(2, Math.min(16, peer.limit)); peer.adjustedAt = this.now();
    }
  }
  class UploadLimiter {
    constructor() { this.rate = 0; this.burst = 128 * 1024; this.tokens = this.burst; this.updatedAt = performance.now(); this.queue = []; this.timer = null; }
    setLimit(mbPerSecond) {
      if (![0, 2, 5, 10, 20].includes(mbPerSecond)) throw new Error('Invalid upload limit');
      this.refill(); this.rate = mbPerSecond * 1024 ** 2; this.tokens = Math.min(this.tokens, this.burst); this.pump();
    }
    refill() { const now = performance.now(); this.tokens = Math.min(this.burst, this.tokens + (now - this.updatedAt) / 1000 * this.rate); this.updatedAt = now; }
    take(bytes, signal) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.burst || this.queue.length >= 512) return Promise.reject(new Error('Invalid upload frame'));
      if (signal?.aborted) return Promise.reject(new Error('Upload cancelled'));
      return new Promise((resolve, reject) => {
        const entry = { bytes, resolve, reject, signal };
        entry.abort = () => { const index = this.queue.indexOf(entry); if (index !== -1) this.queue.splice(index, 1); reject(new Error('Upload cancelled')); this.pump(); };
        signal?.addEventListener('abort', entry.abort, { once: true }); this.queue.push(entry); this.pump();
      });
    }
    pump() {
      clearTimeout(this.timer); this.timer = null; this.refill();
      while (this.queue.length && (!this.rate || this.tokens >= this.queue[0].bytes)) {
        const entry = this.queue.shift(); if (this.rate) this.tokens -= entry.bytes;
        entry.signal?.removeEventListener('abort', entry.abort); entry.resolve();
      }
      if (this.queue.length) this.timer = setTimeout(() => this.pump(), Math.max(1, Math.ceil((this.queue[0].bytes - this.tokens) / this.rate * 1000)));
    }
  }
  function mediaError(code, status = null) {
    return Object.assign(new Error(code), { code, status, retryable: ['network', 'timeout', 'truncated'].includes(code) || [408, 429, 500, 502, 503, 504].includes(status) });
  }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
      const timer = setTimeout(() => finish(), ms);
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async function retryMedia(action, signal, onRetry = () => {}) {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      try { return await action(); }
      catch (error) {
        if (signal?.aborted || attempt >= 2 || !(error.retryable || error instanceof TypeError)) throw error;
        onRetry(error); await delay(300 * 2 ** attempt, signal);
      }
    }
  }
  // Keep only one transport frame in addition to the downloader's existing parts.
  // A proxy's full 200 response is consumed once, including all missing ranges.
  async function readHttpMedia(response, { from, to, size, signal, onPart, onBytes = () => {}, onTimeout = () => {}, idleMs = 15000 }) {
    if (![200, 206].includes(response.status)) { await response.body?.cancel().catch(() => {}); throw mediaError('http', response.status); }
    const full = response.status === 200, expected = full ? size : to - from + 1;
    const range = response.headers.get('Content-Range');
    const length = response.headers.get('Content-Length'), encoding = response.headers.get('Content-Encoding');
    if ((!full && range !== `bytes ${from}-${to}/${size}`) || full && range && range !== `bytes 0-${size - 1}/${size}` ||
      length !== null && (!encoding || encoding === 'identity') && Number(length) !== expected || !response.body?.getReader) {
      await response.body?.cancel().catch(() => {}); throw mediaError('range', response.status);
    }
    const reader = response.body.getReader(); let total = 0, offset = full ? 0 : from;
    const cancelled = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancelled, { once: true });
    let frame = new Uint8Array(Math.min(65536, size - offset)), filled = 0;
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(mediaError('timeout')); }, idleMs); });
        let result;
        try { result = await Promise.race([reader.read(), timeout]); } finally { clearTimeout(timer); }
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (result.done) break;
        const bytes = result.value; total += bytes.byteLength; onBytes(bytes.byteLength);
        if (total > expected) throw mediaError('size');
        for (let at = 0; at < bytes.byteLength;) {
          const count = Math.min(frame.length - filled, bytes.byteLength - at);
          frame.set(bytes.subarray(at, at + count), filled); at += count; filled += count;
          if (filled === frame.length) {
            await onPart(offset / 65536, frame.buffer); offset += filled; filled = 0;
            frame = new Uint8Array(Math.min(65536, Math.max(0, size - offset)));
          }
        }
      }
      if (total !== expected || filled) throw mediaError('truncated');
      return { full, bytes: total };
    } catch (error) {
      if (!signal?.aborted && error instanceof TypeError) throw mediaError('network');
      throw error;
    } finally { signal?.removeEventListener('abort', cancelled); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  const api = { rangesFromIndexes, validRanges, contains, UploadLimiter, DownloadScheduler, mediaError, delay, retryMedia, readHttpMedia };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineTransferUtils = api;
})(typeof window === 'undefined' ? globalThis : window);
