// Shared millisecond bounds and relative moves for every editor input path.
(function(global) {
  'use strict';
  const MAX_SECONDS = 43200;
  const round = value => Math.round(value * 1000) / 1000;
  const limit = duration => Number.isFinite(duration) && duration > 0 ? Math.min(MAX_SECONDS, Math.floor(duration * 1000 + 1e-7) / 1000) : MAX_SECONDS;
  function valid(startRaw, endRaw, duration, minimum = 0.1) {
    const start = Number(startRaw), end = Number(endRaw);
    if (startRaw === null || endRaw === null || startRaw === '' || endRaw === '' || !Number.isFinite(start) || !Number.isFinite(end)) return null;
    const bounds = { start: round(start), end: round(end) };
    return bounds.start >= 0 && bounds.end <= limit(duration) &&
      Math.round((bounds.end - bounds.start) * 1000) >= Math.max(1, Math.round(minimum * 1000)) ? bounds : null;
  }
  function create(time, duration) {
    const end = limit(duration);
    if (!Number.isFinite(time) || time < 0 || time >= end || end < 0.1) return null;
    const start = round(Math.min(time, end - 0.1));
    return valid(start, Math.min(end, round(start + 2)), duration);
  }
  function move(lines, requested, duration) {
    if (!lines.length || !Number.isFinite(requested)) return 0;
    const lower = -Math.min(...lines.map(line => line.start));
    const upper = limit(duration) - Math.max(...lines.map(line => line.end));
    return upper < lower ? 0 : round(Math.max(lower, Math.min(upper, requested)));
  }
  function resize(line, edge, requested, duration, minimum = Math.min(0.1, round(line.end - line.start))) {
    if (!Number.isFinite(requested)) return null;
    const start = edge === 'start' ? round(Math.max(0, Math.min(line.end - minimum, requested))) : line.start;
    const end = edge === 'end' ? round(Math.max(line.start + minimum, Math.min(limit(duration), requested))) : line.end;
    return valid(start, end, duration, minimum);
  }
  function roles(lines, tracks, delta) {
    const updates = new Map();
    for (const line of lines) {
      const index = tracks.indexOf(line.character);
      if (index < 0 || !tracks[index + delta]) return null;
      updates.set(line.id, tracks[index + delta]);
    }
    return updates;
  }
  function numbers(lines) { return new Map([...lines].sort((a, b) => a.start - b.start || a.id - b.id).map((line, index) => [line.id, index + 1])); }
  function coordinate(clientX, originLeft, pixelsPerSecond) { return (clientX - originLeft) / pixelsPerSecond; }
  function laneGeometry(laneCount, preferredHeight) {
    const count = Number.isSafeInteger(laneCount) && laneCount > 0 ? laneCount : 1;
    const padding = 6, gap = 6, minimum = padding * 2 + count * 48 + (count - 1) * gap;
    const preferred = Number.isFinite(preferredHeight) && preferredHeight > 0 ? Math.min(600, preferredHeight) : minimum;
    const height = Math.max(minimum, preferred);
    const cueHeight = (height - padding * 2 - (count - 1) * gap) / count;
    return { height, minimum, cueHeight, stride: cueHeight + gap, padding, gap };
  }
  const api = Object.freeze({ MAX_SECONDS, limit, valid, create, move, resize, roles, numbers, coordinate, laneGeometry });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DublineTimeline = api;
})(typeof window !== 'undefined' ? window : globalThis);
