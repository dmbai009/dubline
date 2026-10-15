(function(root) {
  // Current role first, with a chronological wrap; then the earliest other owned role.
  function next(lines, currentId, { nick, owner, available = () => true } = {}) {
    if (!nick || typeof owner !== 'function') return null;
    const ordered = [...lines].sort((a, b) => a.start - b.start || a.id - b.id);
    const current = ordered.find(line => line.id === currentId);
    const eligible = ordered.filter(line => line.id !== currentId && !line.audioUrl && owner(line) === nick && available(line));
    const same = current ? eligible.filter(line => line.character === current.character) : [];
    const index = current ? ordered.indexOf(current) : -1;
    return same.find(line => ordered.indexOf(line) > index) || same[0] || eligible[0] || null;
  }
  const api = { next }; if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineNextLineModel = api;
})(typeof window === 'undefined' ? globalThis : window);
