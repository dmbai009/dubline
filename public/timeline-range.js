// A private audition/export range. Cue selection and shared scene data are independent.
(() => {
  let value = null, sceneId = null, sourceUrl = null, armed = false, timer = null, frame = null;
  const overlay = document.createElement('div'); overlay.className = 'timeline-time-range'; overlay.hidden = true;
  const band = document.createElement('div'); band.className = 'timeline-time-range timeline-range-band'; band.hidden = true;
  const bar = document.createElement('div'); bar.className = 'timeline-range-tools'; bar.hidden = true;
  const label = document.createElement('span'), clear = document.createElement('button'), exportButton = document.createElement('button');
  const clearText = document.createElement('span'), exportText = document.createElement('span');
  const clearIcon = document.createElement('span'), exportIcon = document.createElement('span');
  clearText.className = exportText.className = 'range-action-text'; clearIcon.className = exportIcon.className = 'range-action-icon';
  clearIcon.textContent = '×'; exportIcon.textContent = '↗'; clearIcon.setAttribute('aria-hidden', 'true'); exportIcon.setAttribute('aria-hidden', 'true');
  clear.append(clearIcon, clearText); exportButton.append(exportIcon, exportText);
  clear.className = exportButton.className = 'btn-outline'; clear.type = exportButton.type = 'button';
  bar.append(label, exportButton, clear); document.querySelector('.zoom-controls').before(bar);
  const clock = seconds => { const ms = Math.round(seconds * 1000); return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
  function get() { return session?.mode === 'dub' && session.activeSessionId === sceneId && session.videoUrl === sourceUrl && value ? { ...value } : null; }
  function disarm() { armed = false; clearTimeout(timer); cancelAnimationFrame(frame); timer = frame = null; }
  function paint() {
    const range = get(); overlay.hidden = band.hidden = bar.hidden = !range;
    if (!range) return;
    if (overlay.parentNode !== timeline) timeline.append(overlay);
    overlay.style.left = `${labelWidth + range.start * pxPerSec}px`; overlay.style.width = `${(range.end - range.start) * pxPerSec}px`;
    const ruler = timeline.querySelector('.ruler-ticks'); if (ruler && band.parentNode !== ruler) ruler.append(band);
    band.style.left = `${range.start * pxPerSec}px`; band.style.width = overlay.style.width;
    label.textContent = t('range.selection', { start: clock(range.start), end: clock(range.end), duration: clock(range.end - range.start) });
    clearText.textContent = t('range.clear'); exportText.textContent = t('range.export');
    clear.title = clear.ariaLabel = t('range.clear'); exportButton.title = exportButton.ariaLabel = t('range.export');
    label.title = label.textContent;
    exportButton.disabled = recordState !== 'idle' || renderInProgress;
  }
  function set(start, end) {
    const duration = Number(video.duration);
    if (session?.mode !== 'dub' || !Number.isFinite(duration) || duration <= 0) return false;
    start = Math.max(0, Math.min(duration, start)); end = Math.max(0, Math.min(duration, end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || Math.abs(end - start) < .01) return false;
    disarm(); sceneId = session.activeSessionId; sourceUrl = session.videoUrl; value = { start: Math.min(start, end), end: Math.max(start, end) }; paint();
    window.dispatchEvent(new Event('dubline-range-changed')); return true;
  }
  function reset() { const changed = !!value; disarm(); value = null; paint(); if (changed) window.dispatchEvent(new Event('dubline-range-changed')); }
  function beforePlay() {
    disarm(); const range = get(); if (!range) return;
    if (video.currentTime < range.start || video.currentTime >= range.end - .005) video.currentTime = range.start;
    armed = true;
  }
  function watch() {
    clearTimeout(timer); cancelAnimationFrame(frame); timer = frame = null;
    const range = get(); if (!armed || !range || video.paused || recordState !== 'idle' || renderInProgress) return;
    if (video.currentTime >= range.end - .002) {
      disarm(); video.pause(); video.currentTime = range.end; window.sendHostSync?.(false); return;
    }
    // A timer still runs in a background window; animation frames keep the visible edge responsive.
    timer = setTimeout(watch, Math.max(4, Math.min(100, (range.end - video.currentTime) / video.playbackRate * 1000)));
    frame = requestAnimationFrame(watch);
  }
  clear.onclick = reset;
  exportButton.onclick = () => { openRenderModal(); window.DublineVideoExportPanel?.selectRange(); };
  video.addEventListener('playing', watch); video.addEventListener('seeked', watch); video.addEventListener('ratechange', watch); video.addEventListener('timeupdate', watch);
  video.addEventListener('pause', disarm);
  // Capture on the stable scroller: ordinary room redraws may replace every row.
  let gesture = null, emptyClick = false, dragged = false;
  const surface = (target, x) => target.closest('.ruler-ticks') ||
    (target.matches('.track-timeline,.timeline-outside') ? target.closest('.track-timeline') : null) ||
    ((target === timeline || target === timelineContainer) && x >= (timeline.querySelector('.ruler-ticks')?.getBoundingClientRect().left ?? Infinity));
  const timeAt = x => {
    const ruler = timeline.querySelector('.ruler-ticks'); if (!ruler) return 0;
    const box = ruler.getBoundingClientRect(), scale = box.width / ruler.offsetWidth || 1;
    return Math.max(0, Math.min(video.duration, (x - box.left) / (pxPerSec * scale)));
  };
  timelineContainer.addEventListener('pointerdown', event => {
    emptyClick = false;
    if (session?.mode !== 'dub' || event.button !== 0 || !surface(event.target, event.clientX) || !studioCanTransport() || gesture) return;
    event.preventDefault(); event.stopImmediatePropagation();
    emptyClick = true; dragged = false; disarm(); video.pause();
    timelineContainer.setPointerCapture(event.pointerId); window.transportScrubbing = true;
    gesture = { pointerId: event.pointerId, x: event.clientX, anchor: timeAt(event.clientX), previous: get(), scene: session.activeSessionId, pending: event.clientX, frame: null };
  }, true);
  function moveSelection() {
    const g = gesture; if (!g) return; g.frame = null;
    if (g.scene !== session?.activeSessionId || session?.mode !== 'dub' || !studioCanTransport()) { finishSelection({ type: 'cancel' }); return; }
    if (dragged && !set(g.anchor, timeAt(g.pending))) reset();
    const box = timelineContainer.getBoundingClientRect(), scale = box.width / timelineContainer.offsetWidth || 1;
    const edge = g.pending < box.left + labelWidth * scale + 16 ? -1 : g.pending > box.right - 16 ? 1 : 0;
    if (dragged && edge) { timelineContainer.scrollLeft += edge * 12; g.frame = requestAnimationFrame(moveSelection); }
  }
  timelineContainer.addEventListener('pointermove', event => {
    const g = gesture; if (!g || event.pointerId !== g.pointerId) return;
    g.pending = event.clientX; dragged ||= Math.abs(g.pending - g.x) > 4;
    if (g.frame === null) g.frame = requestAnimationFrame(moveSelection);
  });
  function finishSelection(event) {
    const g = gesture; if (!g || event.pointerId != null && event.pointerId !== g.pointerId) return;
    cancelAnimationFrame(g.frame); gesture = null; window.transportScrubbing = false;
    if (g.scene === session?.activeSessionId && session?.mode === 'dub') {
      if (event.type === 'pointerup') {
        if (dragged) { if (!set(g.anchor, timeAt(event.clientX))) reset(); video.currentTime = get()?.start ?? g.anchor; }
        else { reset(); video.currentTime = timeAt(event.clientX); }
        window.sendHostSync?.(false);
      } else if (g.previous) set(g.previous.start, g.previous.end); else reset();
    }
    if (timelineContainer.hasPointerCapture(g.pointerId)) timelineContainer.releasePointerCapture(g.pointerId);
  }
  for (const name of ['pointerup','pointercancel','lostpointercapture']) timelineContainer.addEventListener(name, finishSelection);
  window.addEventListener('blur', finishSelection);
  timelineContainer.addEventListener('click', event => { if (session?.mode === 'dub' && emptyClick && (event.target === timelineContainer || surface(event.target))) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  timelineContainer.addEventListener('dblclick', event => {
    if (session?.mode !== 'dub' || !emptyClick || dragged || !studioCanTransport()) return;
    event.preventDefault(); event.stopImmediatePropagation(); set(0, video.duration); video.currentTime = 0; window.sendHostSync?.(false);
  }, true);
  socket.on('session_updated', () => {
    if (gesture && (gesture.scene !== session?.activeSessionId || session?.mode !== 'dub')) finishSelection({ type: 'cancel' });
    if (sceneId !== session?.activeSessionId || sourceUrl !== session?.videoUrl || session?.mode !== 'dub') reset(); else paint();
  });
  new MutationObserver(paint).observe(timeline, { childList: true });
  window.addEventListener('dubline-role-width-changed', paint); window.addEventListener('dubline-language-changed', paint);
  window.DublineTimelineRange = Object.freeze({ get, set, clear: reset, paint, beforePlay, disarm });
})();
