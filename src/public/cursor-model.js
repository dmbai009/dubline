(function(root) {
  function normalize(data, sessionId, roles) {
    if (!data || data.sessionId !== sessionId || !Number.isSafeInteger(data.seq) || data.seq < 0 || typeof data.active !== 'boolean') return null;
    if (!data.active) return { sessionId, seq: data.seq, active: false };
    if (!Number.isFinite(data.time) || data.time < 0 || data.time > 43200 || !Number.isFinite(data.relativeY) || data.relativeY < 0 || data.relativeY > 1 || typeof data.rowKey !== 'string' || data.rowKey.length > 200) return null;
    if (data.rowType === 'role' ? !Array.isArray(roles) || !roles.includes(data.rowKey) : data.rowType === 'audio' ? !['original', 'backing', 'dub'].includes(data.rowKey) : data.rowType !== 'ruler' || data.rowKey !== 'ruler') return null;
    return { sessionId, seq: data.seq, active: true, time: data.time, relativeY: data.relativeY, rowType: data.rowType, rowKey: data.rowKey };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { normalize }; else root.DublineCursorModel = { normalize };
})(typeof window === 'undefined' ? globalThis : window);
