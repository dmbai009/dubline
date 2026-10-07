// Decode only visible cue waves. The observer holds geometry, never PCM buffers.
(() => {
  const waiting = new Map();
  let active = 0, frame = null;
  const visible = canvas => {
    if (!canvas.isConnected || document.hidden) return false;
    const box = canvas.parentElement.getBoundingClientRect(), view = timelineContainer.getBoundingClientRect();
    return box.right >= view.left + labelWidth && box.left <= view.right && box.bottom >= view.top && box.top <= view.bottom;
  };
  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
    for (const entry of entries) { const job = waiting.get(entry.target); if (job) job.visible = entry.isIntersecting; }
    pump();
  }, { root: timelineContainer });
  function pump() {
    for (const [canvas, job] of waiting) {
      if (!canvas.isConnected || job.scene !== session?.activeSessionId) { waiting.delete(canvas); observer?.unobserve(canvas); continue; }
      if (active >= 2 || !(observer ? job.visible : visible(canvas))) continue;
      waiting.delete(canvas); observer?.unobserve(canvas); active++;
      Promise.resolve().then(job.run).finally(() => { active--; pump(); });
    }
  }
  function schedule() { if (frame !== null) return; frame = requestAnimationFrame(() => { frame = null; pump(); }); }
  window.DublineCueWaves = {
    observe(canvas, run) { waiting.set(canvas, { run, scene: session?.activeSessionId, visible: false }); observer?.observe(canvas); schedule(); },
    stats: () => ({ active, waiting: waiting.size })
  };
  timelineContainer.addEventListener('scroll', schedule, { passive: true });
  document.addEventListener('visibilitychange', schedule);
  document.addEventListener('DOMContentLoaded', () => socket.on('session_updated', schedule));
})();
