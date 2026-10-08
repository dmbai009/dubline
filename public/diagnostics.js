// Optional, read-only presentation of existing counters. No extra network polls.
(() => {
  const counters = { fullRenders: 0, incrementalRenders: 0, waveformRenders: 0, lastRenderMs: 0, lastResyncAt: null };
  function count(name, metric) {
    const original = window[name];
    if (typeof original !== 'function') return;
    window[name] = function(...args) {
      const started = performance.now(); counters[metric]++;
      try { return original.apply(this, args); }
      finally { if (name === 'renderTimeline') counters.lastRenderMs = +(performance.now() - started).toFixed(2); }
    };
  }
  count('renderTimeline', 'fullRenders'); count('refreshEditorTimeline', 'incrementalRenders'); count('drawWaveform', 'waveformRenders');
  const panel = document.createElement('details'); panel.className = 'setting-card'; panel.id = 'performanceDiagnostics';
  const title = document.createElement('summary'), output = document.createElement('pre');
  output.style.cssText = 'white-space:pre-wrap;font-size:11px;max-height:300px;overflow:auto';
  panel.append(title, output); window.addSettingsCard('user', 'storage', panel);
  function titleText() { title.textContent = ({ en: 'Advanced diagnostics', ru: 'Расширенная диагностика', uk: 'Розширена діагностика' })[DublineI18n.getLanguage()] || 'Advanced diagnostics'; }
  window.addEventListener('dubline-language-changed', titleText); titleText();
  function sample() {
    const begin = Math.max(0, (timelineContainer.scrollLeft - labelWidth) / pxPerSec), end = begin + timelineContainer.clientWidth / pxPerSec;
    return { build: window.DublineBuildInfo, timeline: { ...counters, totalCues: session?.lines?.length || 0, visibleCues: session?.lines?.filter(line => line.end >= begin && line.start <= end).length || 0 },
      audio: audio.cacheStats(), waveformCache: peaksCache.stats(), cpu: window.DublineCpuJobs?.stats(), cueWaveJobs: window.DublineCueWaves?.stats(),
      network: window.DublineNetwork?.stats(),
      media: { id: session?.videoHash?.slice(0, 12), downloadRate: playerActivities.get(myName)?.downloadRate || 0, uploadRate: window.mediaUploadRate?.() || 0 },
      collaboration: { connected: socket.connected, sessionId: session?.activeSessionId, protocol: latestSessionProtocol,
        pending: editorQueue.length, conflicts: editorConflicts.length, locks: window.DublineEditLeases?.stats(), cursors: window.DublineCursorPresence?.stats() } };
  }
  function paint() { if (panel.open && !document.hidden && settingsModal.style.display === 'flex') output.textContent = JSON.stringify(sample(), null, 2); }
  panel.addEventListener('toggle', paint); setInterval(paint, 1000);
  window.DublineDiagnostics = { sample, counters };
})();
