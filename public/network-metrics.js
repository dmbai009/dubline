// Passive presentation metrics, independent of editing authority and persistence.
(function(root) {
  const TTL = 15000;
  const bytes = value => typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value?.byteLength ?? value?.size ?? 0;
  const category = rtt => !Number.isFinite(rtt) ? 'unknown' : rtt <= 80 ? 'good' : rtt <= 180 ? 'fair' : rtt <= 350 ? 'slow' : 'poor';
  function rate(value) {
    if (!Number.isFinite(value)) return '—';
    if (!value) return '0 KB/s';
    const unit = value >= 1048576 ? 'MB/s' : value >= 1024 ? 'KB/s' : 'B/s';
    const number = value / (unit === 'MB/s' ? 1048576 : unit === 'KB/s' ? 1024 : 1);
    return `${number >= 100 ? Math.round(number) : Number(number.toFixed(1))} ${unit}`;
  }
  function meter() {
    let up = 0, down = 0, previous = null, samples = [];
    return {
      totals: () => ({ up, down }),
      add(direction, value) { if (Number.isFinite(value) && value > 0) { if (direction === 'up') up += value; else if (direction === 'down') down += value; } },
      sample(now) {
        if (previous === null) { previous = { now, up, down }; return { up: 0, down: 0 }; }
        const seconds = (now - previous.now) / 1000;
        if (seconds <= 0) return { up: 0, down: 0 };
        samples.push({ up: (up - previous.up) / seconds, down: (down - previous.down) / seconds });
        samples = samples.slice(-3); previous = { now, up, down };
        return { up: samples.reduce((n, s) => n + s.up, 0) / samples.length, down: samples.reduce((n, s) => n + s.down, 0) / samples.length };
      }
    };
  }
  function latency() {
    let samples = [], last = -Infinity;
    return {
      add(value, now) { if (Number.isFinite(value) && value >= 0 && value <= 60000) { samples = [...samples.slice(-4), value]; last = now; } },
      get(now) { return now - last >= TTL || !samples.length ? null : Math.round(samples.reduce((a, b) => a + b, 0) / samples.length); },
      reset() { samples = []; last = -Infinity; }
    };
  }
  const api = { TTL, bytes, category, rate, meter, latency };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DublineNetworkMetrics = api;
})(typeof window === 'object' ? window : globalThis);
