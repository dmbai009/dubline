(function(root) {
  class ByteCache extends Map {
    constructor(limit, pinned = () => false) { super(); this.limit = limit; this.pinned = pinned; this.sizes = new Map(); this.durations = new Map(); this.bytes = 0; this.evictions = 0; }
    get(key) { const value = super.get(key); if (value) { super.delete(key); super.set(key, value); } return value; }
    set(key, value) {
      this.delete(key); super.set(key, value);
      Promise.resolve(value).then(buffer => {
        if (super.get(key) !== value) return;
        const bytes = ArrayBuffer.isView(buffer) ? buffer.byteLength : buffer ? buffer.length * buffer.numberOfChannels * 4 : 0;
        this.sizes.set(key, bytes); this.durations.set(key, Number(buffer?.duration) || 0); this.bytes += bytes; this.trim();
      }, () => { if (super.get(key) === value) this.delete(key); }); return this;
    }
    delete(key) { this.bytes -= this.sizes.get(key) || 0; this.sizes.delete(key); this.durations.delete(key); return super.delete(key); }
    clear() { super.clear(); this.sizes.clear(); this.durations.clear(); this.bytes = 0; }
    duration(key) { return this.durations.get(key) || 0; }
    trim() {
      for (const key of this.keys()) {
        if (this.bytes <= this.limit) break;
        if (!this.sizes.has(key) || this.pinned(key)) continue;
        this.delete(key); this.evictions++;
      }
    }
    stats() { return { bytes: this.bytes, entries: this.size, limit: this.limit, evictions: this.evictions }; }
  }
  class IntervalIndex {
    constructor(entries) {
      const sorted = entries.filter(entry => Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.end >= entry.start).sort((a, b) => a.start - b.start);
      const build = (start, end) => { if (start >= end) return null; const middle = (start + end) >>> 1;
        const node = { entry: sorted[middle], left: build(start, middle), right: build(middle + 1, end) };
        node.maxEnd = Math.max(node.entry.end, node.left?.maxEnd ?? -Infinity, node.right?.maxEnd ?? -Infinity); return node;
      };
      this.root = build(0, sorted.length); this.visited = 0; this.queries = 0;
    }
    query(from, to = from) {
      const result = []; this.visited = 0; this.queries++;
      const visit = node => {
        if (!node || node.maxEnd < from) return;
        this.visited++; visit(node.left);
        if (node.entry.start <= to && node.entry.end >= from) result.push(node.entry.value);
        if (node.entry.start <= to) visit(node.right);
      };
      visit(this.root); return result;
    }
  }
  const api = { ByteCache, IntervalIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineAudioMemory = api;
})(typeof window === 'undefined' ? globalThis : window);
