// Personal timeline geometry only: no room mutation, cue rebuild or zoom change.
(() => {
  const KEY = 'dubline_role_column_width', MIN = 180, MAX = 400;
  let preferred = MIN, active = null, frame = null, edgeClick = false, limit = MIN;
  try {
    const saved = Number(localStorage.getItem(KEY));
    if (Number.isFinite(saved) && saved >= MIN) preferred = Math.min(MAX, saved);
  } catch { /* Storage may be unavailable; resizing still works for this page. */ }
  const scale = () => timelineContainer.getBoundingClientRect().width / timelineContainer.offsetWidth || 1;
  const maximum = () => {
    const box = timelineContainer.getBoundingClientRect();
    const visible = Math.max(0, Math.min(innerWidth, box.right) - Math.max(0, box.left)) / scale();
    return Math.max(MIN, Math.min(MAX, Math.floor(Math.min(timelineContainer.clientWidth, visible) * .55)));
  };
  const save = () => { try { localStorage.setItem(KEY, String(preferred)); } catch { /* Personal preference only. */ } };
  function apply() {
    limit = maximum();
    const next = Math.round(Math.max(MIN, Math.min(limit, preferred)));
    if (labelWidth !== next) {
      labelWidth = next;
      timeline.style.setProperty('--role-column-width', `${next}px`);
      const trackWidth = parseFloat(timeline.querySelector('.ruler-ticks')?.style.width);
      if (Number.isFinite(trackWidth)) timeline.style.width = `${Math.max(timelineContainer.clientWidth, next + trackWidth)}px`;
      playhead.style.left = `${next + video.currentTime * pxPerSec}px`;
      window.paintStudioTimelineWaves?.();
      window.dispatchEvent(new Event('dubline-role-width-changed'));
    }
    for (const handle of timeline.querySelectorAll('.role-column-handle')) {
      handle.setAttribute('aria-valuenow', String(next));
      handle.setAttribute('aria-valuemax', String(limit));
    }
  }
  function resize(value) {
    preferred = Math.round(Math.max(MIN, Math.min(maximum(), value)));
    // Resizing this column must not implicitly invoke "Whole scene" scaling.
    if (preferred !== labelWidth) timelineFitActive = false;
    apply();
  }
  function attach(root) {
    const labels = [...root.querySelectorAll('.track-label,.ruler-corner')];
    if (root.matches('.track-label,.ruler-corner')) labels.push(root);
    for (const label of labels) {
      if (label.querySelector('.role-column-handle')) continue;
      const handle = document.createElement('span');
      handle.className = 'role-column-handle'; handle.tabIndex = 0;
      handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-valuemin', String(MIN));
      handle.setAttribute('aria-valuenow', String(labelWidth));
      handle.setAttribute('aria-valuemax', String(limit));
      handle.title = `${t('rolesTrack')} · ${t('splitter.hint')}`;
      handle.setAttribute('aria-label', handle.title);
      label.append(handle);
    }
    if (root === timeline) apply();
  }
  timelineContainer.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.role-column-handle');
    edgeClick = false;
    if (!handle) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.button !== 0 || active || window.activeEditorGesture || window.transportScrubbing) return;
    active = { pointer: event.pointerId, x: event.clientX, width: labelWidth, preferred, fit: timelineFitActive };
    // The stable scroller retains capture when a room update redraws role labels.
    timelineContainer.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-role-column');
  }, true);
  const paint = () => {
    frame = null;
    if (active) resize(active.width + (active.pending - active.x) / scale());
  };
  timelineContainer.addEventListener('pointermove', event => {
    if (!active || event.pointerId !== active.pointer) return;
    event.preventDefault(); event.stopImmediatePropagation(); active.pending = event.clientX;
    if (frame === null) frame = requestAnimationFrame(paint);
  }, true);
  function finish(event) {
    if (!active || event.pointerId != null && event.pointerId !== active.pointer) return;
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    const old = active;
    if (event.type === 'pointerup') {
      edgeClick = Math.abs(event.clientX - old.x) < 3;
      active.pending = event.clientX; paint(); save();
    } else {
      preferred = old.preferred; timelineFitActive = old.fit; apply();
    }
    active = null;
    document.body.classList.remove('resizing-role-column');
    if (timelineContainer.hasPointerCapture(old.pointer)) timelineContainer.releasePointerCapture(old.pointer);
  }
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) timelineContainer.addEventListener(name, event => {
    if (!active) return;
    event.stopImmediatePropagation(); finish(event);
  }, true);
  window.addEventListener('blur', finish);
  timelineContainer.addEventListener('click', event => {
    if (event.target.closest('.role-column-handle')) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  timelineContainer.addEventListener('dblclick', event => {
    // Captured pointer clicks are retargeted to the scroller by the browser.
    if (!event.target.closest('.role-column-handle') && !(event.target === timelineContainer && edgeClick)) return;
    event.preventDefault(); event.stopImmediatePropagation(); resize(MIN); save();
  }, true);
  timelineContainer.addEventListener('keydown', event => {
    if (!event.target.matches('.role-column-handle')) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    resize(event.key === 'Home' ? MIN : event.key === 'End' ? maximum() : labelWidth + (event.key === 'ArrowRight' ? 10 : -10)); save();
  }, true);
  new ResizeObserver(apply).observe(timelineContainer);
  window.addEventListener('resize', apply);
  const zoomObserver = new MutationObserver(apply);
  for (const node of [document.documentElement, document.body]) zoomObserver.observe(node, { attributes: true, attributeFilter: ['style'] });
  window.DublineRoleColumn = Object.freeze({ attach });
  attach(timeline);
})();
