// Progress comes from completed work, independently of the UI heartbeat.
(function(root) {
  function create(now = () => performance.now()) {
    const started = now(), rows = new Map(); let lastAdvance = started, current = 'checking', waitingForUser = false;
    function update(phase, data = {}) {
      const old = rows.get(phase), next = { phase, unit: 'seconds', state: 'running', ...old, ...data };
      if (Number.isFinite(next.current)) next.current = Math.max(old?.current || 0, next.current, 0);
      if (Number.isFinite(next.total)) next.total = Math.max(next.total, next.current || 0, 0);
      const moved = !old || next.current !== old.current || next.state !== old.state || next.detail !== old.detail || next.label !== old.label;
      rows.set(phase, next); current = phase; if (moved) lastAdvance = now();
    }
    return { update, restart: () => { rows.clear(); lastAdvance = now(); current = 'checking'; }, resetPhase: phase => { rows.delete(phase); lastAdvance = now(); }, waiting: value => { if (waitingForUser !== value) lastAdvance = now(); waitingForUser = value; }, snapshot: () => ({
      current, rows: [...rows.values()].map(row => ({ ...row })), elapsed: Math.max(0, now() - started),
      quiet: Math.max(0, now() - lastAdvance), stalled: !waitingForUser && now() - lastAdvance >= 15000, waitingForUser
    }) };
  }
  const api = { create }; if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineExportProgress = api;
})(typeof window === 'undefined' ? globalThis : window);
