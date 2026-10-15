(function(root) {
  function next(lines, currentId, { nick, owner, visible = () => true, mode = 'missing', skipped = new Set() } = {}) {
    if (!nick || typeof owner !== 'function') return null;
    const ordered = [...lines].sort((a, b) => a.start - b.start || a.id - b.id), from = currentId == null ? -1 : ordered.findIndex(line => line.id === currentId);
    return ordered.slice(from + 1).find(line => owner(line) === nick && !skipped.has(line.id) && (mode === 'missing' ? !line.audioUrl : mode === 'retake' ? line.audioUrl && line.needsRetake : visible(line))) || null;
  }
  const api = { next }; if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineSequenceModel = api;
})(typeof window === 'undefined' ? globalThis : window);
